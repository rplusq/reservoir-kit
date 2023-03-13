import {
  Execute,
  ReservoirChain,
  ReservoirClientActions,
  isOpenSeaBanned,
  paths,
  setParams,
} from '@reservoir0x/reservoir-sdk'
import { useListings, useReservoirClient, useTokens } from '../hooks'
import { getChainCurrency } from '../hooks/useChainCurrency'
import { defaultFetcher } from '../lib/swr'
import React, {
  createContext,
  useCallback,
  useRef,
  ReactNode,
  useEffect,
  FC,
} from 'react'
import { useAccount, useNetwork, useSwitchNetwork } from 'wagmi'
import { constants, utils } from 'ethers'
import { toFixed } from '../lib/numbers'
import { formatUnits } from 'ethers/lib/utils.js'
import { version } from '../../package.json'
import { fetchSigner, getNetwork } from 'wagmi/actions'

type Order = NonNullable<ReturnType<typeof useListings>['data'][0]>
type Token = NonNullable<ReturnType<typeof useTokens>['data'][0]>
type FloorAsk = NonNullable<NonNullable<Token['market']>['floorAsk']>
type CartItemPrice = FloorAsk['price']
type Currency = NonNullable<NonNullable<CartItemPrice>['currency']>
type BuyTokenOptions = Parameters<
  ReservoirClientActions['buyToken']
>['0']['options']

export enum CheckoutStatus {
  Idle,
  Approving,
  Finalizing,
  Complete,
}

export enum CheckoutTransactionError {
  Unknown,
  PiceMismatch,
  InsufficientBalance,
  UserDenied,
}

type CartItem = {
  token: {
    id: string
    name: string
  }
  collection: {
    id: string
    name: string
  }
  order:
    | {
        id: string
        price: CartItemPrice
        quantityRemaining: number
        quantity: number
        maker: string
      }
    | undefined
  price: CartItemPrice
  poolId?: string
  poolPrices?: CartItemPrice[]
  previousPrice?: CartItemPrice
  isBannedOnOpensea?: boolean
}

export type Cart = {
  totalPrice: number
  currency?: NonNullable<CartItemPrice>['currency']
  referrer?: string
  referrerFeeBps?: number
  referrerFee?: number
  items: CartItem[]
  pools: Record<string, { prices: CartItemPrice[]; itemCount: number }>
  isValidating: boolean
  chain?: ReservoirChain
  pendingTransactionId?: string
  transaction: {
    id?: string
    txHash?: string
    chain: ReservoirChain
    items: CartItem[]
    error?: Error
    errorType?: CheckoutTransactionError
    status: CheckoutStatus
    steps?: Execute['steps']
  } | null
}

const CartStorageKey = `reservoirkit.cart.${version}`

type CartStoreProps = {
  referrer?: string
  referrerFeeBps?: number
  persist?: boolean
}

function cartStore({
  referrer,
  referrerFeeBps,
  persist = true,
}: CartStoreProps) {
  const { address } = useAccount()
  const { chains } = useNetwork()
  const { switchNetworkAsync } = useSwitchNetwork()
  const cartData = useRef<Cart>({
    totalPrice: 0,
    referrerFee: 0,
    items: [],
    pools: {},
    isValidating: false,
    transaction: null,
  })

  const subscribers = useRef(new Set<() => void>())
  const client = useReservoirClient()

  useEffect(() => {
    if (persist && typeof window !== 'undefined' && window.localStorage) {
      const storedCart = window.localStorage.getItem(CartStorageKey)
      if (storedCart) {
        const rehydratedCart: Cart = JSON.parse(storedCart)
        const currency = getCartCurrency(
          rehydratedCart.items,
          rehydratedCart.chain?.id || 1
        )
        const pools = calculatePools(rehydratedCart.items)
        const { totalPrice, referrerFee } = calculatePricing(
          rehydratedCart.items,
          currency,
          cartData.current.referrerFeeBps
        )
        cartData.current = {
          ...cartData.current,
          chain:
            rehydratedCart.items.length > 0 ? rehydratedCart.chain : undefined,
          items: rehydratedCart.items,
          pools,
          totalPrice,
          referrerFee,
          currency,
        }
        subscribers.current.forEach((callback) => callback())
        validate()
      }
    }
  }, [])

  useEffect(() => {
    const feeBps =
      referrer !== undefined && referrerFeeBps !== undefined
        ? referrerFeeBps
        : undefined
    const referrerAddress =
      referrer !== undefined && referrerFeeBps !== undefined
        ? referrer
        : undefined
    const currency = getCartCurrency(
      cartData.current.items,
      cartData.current.chain?.id || 1
    )
    const pools = calculatePools(cartData.current.items)
    const { totalPrice, referrerFee } = calculatePricing(
      cartData.current.items,
      currency,
      feeBps
    )
    cartData.current = {
      ...cartData.current,
      pools,
      totalPrice,
      referrerFee,
      currency,
      referrer: referrerAddress,
      referrerFeeBps: feeBps,
    }
    commit()
  }, [referrer, referrerFeeBps])

  const get = useCallback(() => cartData.current, [])
  const set = useCallback((value: Partial<Cart>) => {
    cartData.current = { ...cartData.current, ...value }
    commit()
  }, [])

  const subscribe = useCallback((callback: () => void) => {
    subscribers.current.add(callback)
    return () => subscribers.current.delete(callback)
  }, [])

  const commit = useCallback(() => {
    subscribers.current.forEach((callback) => callback())
    if (persist && typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(
        CartStorageKey,
        JSON.stringify(cartData.current)
      )
    }
  }, [persist])

  const calculatePools = useCallback((items: CartItem[]) => {
    const pools: Record<
      string,
      { prices: CartItemPrice[]; itemCount: number }
    > = {}
    items.forEach((item) => {
      if (item.poolId) {
        if (!pools[item.poolId] && item.poolPrices) {
          pools[item.poolId] = { prices: item.poolPrices, itemCount: 1 }
          item.price = item.poolPrices[0]
        } else if (item.poolPrices) {
          item.price = item.poolPrices[pools[item.poolId].itemCount]
          pools[item.poolId].itemCount += 1
        }
      }
    })
    return pools
  }, [])

  const calculatePricing = useCallback(
    (
      items: Cart['items'],
      currency?: Cart['currency'],
      referrerFeeBps?: Cart['referrerFeeBps']
    ) => {
      let referrerFee = 0
      let subtotal = items.reduce((total, { price, order }) => {
        let amount = price?.amount?.decimal
        if (price?.currency?.contract !== currency?.contract) {
          amount = price?.amount?.native
        }
        // Test this
        if (order?.price?.amount?.decimal && order?.quantity) {
          amount = order?.price?.amount?.decimal * order?.quantity
        }
        return (total += amount || 0)
      }, 0)
      if (referrerFeeBps) {
        referrerFee = (referrerFeeBps / 10000) * subtotal
        subtotal = subtotal + referrerFee
      }
      return {
        totalPrice: subtotal,
        referrerFee,
      }
    },
    []
  )

  const getCartCurrency = useCallback(
    (items: CartItem[], chainId: number): Currency | undefined => {
      let currencies = new Set<string>()
      let currenciesData: Record<string, Currency> = {}
      for (let i = 0; i < items.length; i++) {
        const currency = items[i].price?.currency
        if (currency?.contract) {
          currencies.add(currency.contract)
          currenciesData[currency.contract] = currency
        }
        if (currencies.size > 1) {
          break
        }
      }
      if (currencies.size > 1) {
        return getChainCurrency(chains, chainId)
      } else if (currencies.size > 0) {
        return Object.values(currenciesData)[0]
      }
    },
    [chains]
  )

  const fetchTokens = useCallback(
    async (tokenIds: string[]) => {
      if (!tokenIds || tokenIds.length === 0) {
        return { tokens: [], flaggedStatuses: {} }
      }
      const reservoirChain = client?.chains.find(
        (chain) => chain.id === cartData.current.chain?.id
      )
      // const url = new URL(`${reservoirChain?.baseApiUrl}/tokens/v5`) TODO: switch back
      const url = new URL(`https://api-polygon.reservoir.tools/tokens/v5`)
      const query: paths['/tokens/v5']['get']['parameters']['query'] = {
        tokens: tokenIds,
        limit: 100,
        includeDynamicPricing: true,
      }
      if (client?.normalizeRoyalties !== undefined) {
        query.normalizeRoyalties = client?.normalizeRoyalties
      }
      setParams(url, query)
      const params = [url.href]
      if (reservoirChain?.apiKey) {
        params.push(reservoirChain.apiKey)
      }
      if (client?.version) {
        params.push(client.version)
      }
      type TokensSchema =
        paths['/tokens/v5']['get']['responses']['200']['schema']
      const promises = await Promise.allSettled([
        defaultFetcher(params),
        isOpenSeaBanned(tokenIds),
      ])
      const response: TokensSchema =
        promises[0].status === 'fulfilled' ? promises[0].value : {}
      const flaggedStatuses =
        promises[1].status === 'fulfilled' ? promises[1].value : {}

      return { tokens: response.tokens, flaggedStatuses }
    },
    [client]
  )

  const fetchOrders = useCallback(
    async (orderIds: string[]) => {
      if (!orderIds || orderIds.length === 0) {
        return { orders: [], flaggedStatuses: {} }
      }
      const reservoirChain = client?.chains.find(
        (chain) => chain.id === cartData.current.chain?.id
      )
      // const url = new URL(`${reservoirChain?.baseApiUrl}/orders/asks/v4`) TODO: switch back
      const url = new URL(`https://api-polygon.reservoir.tools/orders/asks/v4`)
      const query: paths['/orders/asks/v4']['get']['parameters']['query'] = {
        ids: orderIds,
        limit: 1000,
        includeCriteriaMetadata: true,
      }
      if (client?.normalizeRoyalties !== undefined) {
        query.normalizeRoyalties = client?.normalizeRoyalties
      }
      setParams(url, query)
      const params = [url.href]
      if (reservoirChain?.apiKey) {
        params.push(reservoirChain.apiKey)
      }
      if (client?.version) {
        params.push(client.version)
      }
      type OrdersSchema =
        paths['/orders/asks/v4']['get']['responses']['200']['schema']

      const response: OrdersSchema = await defaultFetcher(params)

      const tokenIds = response?.orders?.map(
        ({ criteria }) =>
          `${criteria?.data?.collection?.id}:${criteria?.data?.token?.tokenId}`
      )

      let flaggedStatuses = undefined
      if (tokenIds) {
        flaggedStatuses = (await isOpenSeaBanned(tokenIds)) || {}
      }

      return { orders: response.orders, flaggedStatuses }
    },
    [client]
  )

  const convertTokenToItem = useCallback(
    (tokenData: Token): CartItem | undefined => {
      const token = tokenData.token
      const market = tokenData.market

      if (!token?.tokenId || !token.collection?.id) {
        return
      }
      const dynamicPricing = market?.floorAsk?.dynamicPricing

      let order = undefined
      if (token.kind === 'erc1155' && market?.floorAsk) {
        order = {
          id: market?.floorAsk?.id || '',
          price: market?.floorAsk?.price,
          quantityRemaining: market?.floorAsk?.quantityRemaining || 1,
          quantity: market?.floorAsk?.quantityRemaining || 1,
          maker: market?.floorAsk?.maker || '',
        }
      }

      return {
        token: {
          id: token.tokenId,
          name: token.name || '',
        },
        collection: {
          id: token.collection.id,
          name: token.collection.name || '',
        },
        order: order,
        price:
          dynamicPricing?.kind === 'pool' ? undefined : market?.floorAsk?.price,
        poolId:
          dynamicPricing?.kind === 'pool'
            ? (dynamicPricing.data?.pool as string)
            : undefined,
        poolPrices:
          dynamicPricing?.kind === 'pool'
            ? (dynamicPricing.data?.prices as CartItemPrice[])
            : undefined,
        isBannedOnOpensea: token.isFlagged,
      }
    },
    []
  )

  const convertOrderToItem = useCallback(
    (orderData: Order): CartItem | undefined => {
      let criteria = orderData.criteria?.data
      if (!criteria?.token?.tokenId || !criteria.collection?.id) {
        return
      }
      return {
        token: {
          id: criteria.token.tokenId,
          name: criteria.token.name || '',
        },
        collection: {
          id: criteria.collection.id,
          name: criteria.collection.name || '',
        },
        order: {
          id: orderData.id,
          price: orderData.price,
          quantityRemaining: orderData.quantityRemaining || 1,
          quantity: orderData.quantityRemaining || 1, //update
          maker: orderData.maker,
        },
        price: orderData.price,
        poolId: undefined,
        poolPrices: undefined,
        isBannedOnOpensea: undefined,
      }
    },
    []
  )

  const clear = useCallback(() => {
    cartData.current = {
      ...cartData.current,
      items: [],
      pools: {},
      totalPrice: 0,
      referrerFee: 0,
      chain: undefined,
    }
    commit()
  }, [commit])

  const clearTransaction = useCallback(() => {
    cartData.current = {
      ...cartData.current,
      transaction: null,
      pendingTransactionId: undefined,
    }
    commit()
  }, [commit])

  const setQuantity = useCallback(
    (orderId: string, quantity: number) => {
      const updatedItems = [...cartData.current.items]
      let item = updatedItems.find((item) => item.order?.id === orderId)
      if (item?.order) {
        item.order = {
          ...item.order,
          quantity: quantity,
        }
      }
      const currency = getCartCurrency(
        updatedItems,
        cartData.current.chain?.id || 1
      )
      const { totalPrice, referrerFee } = calculatePricing(
        updatedItems,
        currency,
        cartData.current.referrerFeeBps
      )

      cartData.current = {
        ...cartData.current,
        items: updatedItems,
        totalPrice,
        referrerFee,
        currency,
      }

      commit()
    },
    [commit]
  )

  type AsyncAddToCartOrder = { orderId: string }
  type AsyncAddToCartToken = { id: string }
  type AddToCartToken = AsyncAddToCartToken | AsyncAddToCartOrder | Token

  const add = useCallback(
    async (items: AddToCartToken[], chainId: number) => {
      try {
        if (cartData.current.chain && chainId != cartData.current.chain?.id) {
          throw `ChainId: ${chainId}, is different than the cart chainId (${cartData.current.chain?.id})`
        }
        if (cartData.current.isValidating) {
          throw 'Currently validating, adding items temporarily disabled'
        }

        const updatedItems = [...cartData.current.items]
        const currentIds = cartData.current.items.map(
          (item) => `${item.collection.id}:${item.token.id}`
        )
        const currentOrderIds = cartData.current.items.map(
          (item) => item.order?.id
        )

        const tokensToFetch: string[] = []
        const tokens: Token[] = []
        const ordersToFetch: string[] = []

        items.forEach((item) => {
          const token = item as Token
          const asyncToken = item as AsyncAddToCartToken
          const asyncOrder = item as AsyncAddToCartOrder
          if (token.token) {
            if (
              !currentIds.includes(
                `${token.token?.collection?.id}:${token.token?.tokenId}`
              )
            ) {
              tokens.push(token)
            }
          } else if (
            asyncToken &&
            asyncToken.id &&
            !currentIds.includes(asyncToken.id)
          ) {
            tokensToFetch.push(asyncToken.id)
          } else if (
            asyncOrder &&
            asyncOrder.orderId &&
            !currentOrderIds.includes(asyncOrder.orderId)
          ) {
            ordersToFetch.push(asyncOrder.orderId)
          }
        })

        const promises: Promise<void>[] = []

        if (tokensToFetch.length > 0) {
          promises.push(
            new Promise(async (resolve) => {
              const { tokens: fetchedTokens, flaggedStatuses } =
                await fetchTokens(tokensToFetch)
              fetchedTokens?.forEach((tokenData) => {
                const item = convertTokenToItem(tokenData)
                if (item) {
                  const id = `${item.collection.id}:${item.token.id}`
                  item.isBannedOnOpensea = flaggedStatuses[id]
                    ? flaggedStatuses[id]
                    : item.isBannedOnOpensea
                  updatedItems.push(item)
                }
              })

              resolve()
            })
          )
        }

        if (ordersToFetch.length > 0) {
          promises.push(
            new Promise(async (resolve) => {
              const { orders: fetchedOrders, flaggedStatuses } =
                await fetchOrders(ordersToFetch)
              fetchedOrders?.forEach((orderData) => {
                const item = convertOrderToItem(orderData)
                if (item) {
                  const id = `${item.collection.id}:${item.token.id}`
                  item.isBannedOnOpensea = flaggedStatuses?.[id]
                    ? flaggedStatuses[id]
                    : item.isBannedOnOpensea
                  updatedItems.push(item)
                }
              })

              resolve()
            })
          )
        }

        if (promises.length > 0) {
          cartData.current.isValidating = true
          subscribers.current.forEach((callback) => callback())

          await Promise.all(promises)
        }

        if (tokens.length > 0) {
          tokens.forEach((token) => {
            if (
              token.market?.floorAsk?.maker?.toLowerCase() !==
                address?.toLowerCase() &&
              token.token?.owner?.toLowerCase() !== address?.toLowerCase()
            ) {
              const item = convertTokenToItem(token)
              if (item) {
                updatedItems.push(item)
              }
            }
          })
        }

        const pools = calculatePools(updatedItems)
        const currency = getCartCurrency(updatedItems, chainId)
        const { totalPrice, referrerFee } = calculatePricing(
          updatedItems,
          currency,
          cartData.current.referrerFeeBps
        )

        cartData.current = {
          ...cartData.current,
          isValidating: false,
          items: updatedItems,
          totalPrice,
          referrerFee,
          currency,
          pools,
        }

        if (!cartData.current.chain) {
          cartData.current.chain =
            client?.chains.find((chain) => chain.id === chainId) ||
            client?.currentChain() ||
            undefined
        }
        commit()
      } catch (e) {
        if (cartData.current.isValidating) {
          cartData.current.isValidating = false
          commit()
        }
        throw e
      }
    },
    [fetchTokens, commit, address]
  )

  /**
   * @param ids An array of order ids or token keys in the format `collection:token`
   */

  const remove = useCallback((ids: string[]) => {
    if (cartData.current.isValidating) {
      console.warn('Currently validating, removing items temporarily disabled')
      return
    }
    const updatedItems: CartItem[] = []
    const removedItems: CartItem[] = []
    cartData.current.items.forEach((item) => {
      const key = `${item.collection.id}:${item.token.id}`
      const orderId = item.order?.id
      if (orderId && ids.includes(orderId)) {
        removedItems.push(item)
      } else if (ids.includes(key)) {
        // maybe also make sure the item doesn't have an orderId
        removedItems.push(item)
      } else {
        updatedItems.push(item)
      }
    })
    const pools = calculatePools(updatedItems)
    const currency = getCartCurrency(
      updatedItems,
      cartData.current.chain?.id || 1
    )
    const { totalPrice, referrerFee } = calculatePricing(
      updatedItems,
      currency,
      cartData.current.referrerFeeBps
    )

    //Suppress pool price changes if the removed item was from the pool
    const removedPoolIds = removedItems.reduce((poolIds, item) => {
      if (item.poolId) {
        poolIds.push(item.poolId)
      }
      return poolIds
    }, [] as string[])

    updatedItems.forEach((item) => {
      if (item.poolId && removedPoolIds.includes(item.poolId)) {
        item.previousPrice = item.price
      }
    })

    cartData.current = {
      ...cartData.current,
      items: updatedItems,
      pools,
      totalPrice,
      referrerFee,
      currency,
    }
    if (updatedItems.length === 0) {
      cartData.current.chain = undefined
    }
    commit()
  }, [])

  const validate = useCallback(async () => {
    try {
      if (cartData.current.items.length === 0) {
        return false
      }
      cartData.current = { ...cartData.current, isValidating: true }
      commit()
      const tokenIds = cartData.current.items.reduce((tokens, item) => {
        const contract = item.collection.id.split(':')[0]
        tokens.push(`${contract}:${item.token.id}`)
        return tokens
      }, [] as string[])

      const { tokens, flaggedStatuses } = await fetchTokens(tokenIds)
      const tokenMap =
        tokens?.reduce((tokens, token) => {
          if (token.token?.tokenId && token.token.collection?.id) {
            tokens[`${token.token.collection.id}:${token.token.tokenId}`] =
              token
          }
          return tokens
        }, {} as Record<string, NonNullable<Token>>) || {}
      const items = cartData.current.items
        .filter((item) => {
          const token = tokenMap[`${item.collection.id}:${item.token.id}`]
          return (
            token.token?.owner?.toLowerCase() !== address?.toLowerCase() &&
            token.market?.floorAsk?.maker?.toLowerCase() !==
              address?.toLowerCase()
          )
        })
        .map((item) => {
          const token = tokenMap[`${item.collection.id}:${item.token.id}`]
          const flaggedStatus = flaggedStatuses
            ? flaggedStatuses[`${item.collection.id}:${item.token.id}`]
            : undefined

          if (token) {
            const dynamicPricing = token.market?.floorAsk?.dynamicPricing
            const updatedItem = {
              ...item,
              previousPrice: item.price,
              price: token.market?.floorAsk?.price,
              poolId:
                dynamicPricing?.kind === 'pool'
                  ? (dynamicPricing.data?.pool as string)
                  : undefined,
              poolPrices:
                dynamicPricing?.kind === 'pool'
                  ? (dynamicPricing.data?.prices as CartItemPrice[])
                  : undefined,
            }
            if (token.token?.name) {
              updatedItem.token.name = token.token.name
            }
            if (token.token?.collection?.name) {
              updatedItem.collection.name = token.token.collection.name
            }
            if (flaggedStatus !== undefined) {
              updatedItem.isBannedOnOpensea = flaggedStatus
            }
            return updatedItem
          }
          return item
        })
      const pools = calculatePools(items)
      const currency = getCartCurrency(items, cartData.current.chain?.id || 1)
      const { totalPrice, referrerFee } = calculatePricing(
        items,
        currency,
        cartData.current.referrerFeeBps
      )
      cartData.current = {
        ...cartData.current,
        items,
        pools,
        isValidating: false,
        totalPrice,
        referrerFee,
        currency,
      }
      commit()
      return true
    } catch (e) {
      if (cartData.current.isValidating) {
        cartData.current.isValidating = false
        commit()
      }
      throw e
    }
  }, [fetchTokens, address])

  const checkout = useCallback(
    async (options: BuyTokenOptions = {}) => {
      if (!client) {
        throw 'Reservoir SDK not initialized'
      }

      const { chain: activeChain } = await getNetwork()

      if (
        cartData.current.chain &&
        cartData.current.chain?.id !== activeChain?.id
      ) {
        const chain = await switchNetworkAsync?.(cartData.current.chain.id)
        if (chain?.id !== cartData.current.chain.id) {
          throw 'Active chain does not match cart chain'
        }
      }

      const signer = await fetchSigner({
        chainId: cartData.current.chain?.id,
      })

      if (!signer) {
        throw 'Signer not available'
      }

      let isMixedCurrency = false
      const tokens = cartData.current.items.reduce(
        (items, { token, collection, price }) => {
          if (price) {
            const contract = collection.id.split(':')[0]
            items?.push({
              token: `${contract}:${token.id}`,
            })
            if (
              price.currency?.contract != cartData.current.currency?.contract
            ) {
              isMixedCurrency = true
            }
          }
          return items
        },
        [] as Parameters<ReservoirClientActions['buyToken']>['0']['items']
      )

      if (!tokens || tokens.length === 0) {
        throw 'Cart is empty'
      }
      const chainCurrency = getChainCurrency(
        chains,
        cartData.current.chain?.id || 1
      )
      const currencyChain = client.chains.find(
        (chain) => (chainCurrency.chainId = chain.id)
      )
      const expectedPrice = cartData.current.totalPrice

      if (isMixedCurrency) {
        options.currency = constants.AddressZero
      }

      if (cartData.current.referrer && cartData.current.referrerFeeBps) {
        const price = toFixed(
          expectedPrice,
          cartData.current.currency?.decimals || 18
        )
        const fee = utils
          .parseUnits(`${price}`, cartData.current.currency?.decimals)
          .mul(cartData.current.referrerFeeBps)
          .div(10000)
        const atomicUnitsFee = formatUnits(fee, 0)
        options.feesOnTop = [`${cartData.current.referrer}:${atomicUnitsFee}`]
      }

      if (options.partial === undefined) {
        options.partial = true
      }

      const transactionId = `${new Date().getTime()}`
      cartData.current = {
        ...cartData.current,
        pendingTransactionId: transactionId,
        transaction: {
          id: transactionId,
          chain: cartData.current.chain || currencyChain || client.chains[0],
          items: cartData.current.items,
          status: CheckoutStatus.Approving,
        },
      }
      commit()

      client.actions
        .buyToken({
          expectedPrice,
          signer,
          items: tokens,
          options,
          onProgress: (steps: Execute['steps']) => {
            if (!steps) {
              return
            }
            if (transactionId != cartData.current.pendingTransactionId) {
              return
            }

            let status =
              cartData.current.transaction?.status || CheckoutStatus.Approving

            const executableSteps = steps.filter(
              (step) => step.items && step.items.length > 0
            )

            let currentStepItem:
              | NonNullable<Execute['steps'][0]['items']>[0]
              | undefined

            executableSteps.findIndex((step) => {
              currentStepItem = step.items?.find(
                (item) => item.status === 'incomplete'
              )
              return currentStepItem
            })

            if (currentStepItem) {
              if (currentStepItem.txHash) {
                status = CheckoutStatus.Finalizing
                if (cartData.current.items.length > 0) {
                  cartData.current.items = []
                  cartData.current.pools = {}
                  cartData.current.totalPrice = 0
                  cartData.current.currency = undefined
                  cartData.current.chain = undefined
                }
              }
            } else if (
              steps.every(
                (step) =>
                  !step.items ||
                  step.items.length == 0 ||
                  step.items?.every((item) => item.status === 'complete')
              )
            ) {
              status = CheckoutStatus.Complete
            }

            if (
              cartData.current.transaction?.status != status &&
              (status === CheckoutStatus.Finalizing ||
                status === CheckoutStatus.Complete)
            ) {
              cartData.current.items = []
              cartData.current.pools = {}
              cartData.current.totalPrice = 0
              cartData.current.currency = undefined
              cartData.current.chain = undefined
            }

            if (cartData.current.transaction) {
              cartData.current.transaction.status = status
              if (currentStepItem) {
                cartData.current.transaction.txHash = currentStepItem?.txHash
                cartData.current.transaction.steps = steps
              }
            }
            commit()
          },
        })
        .catch((e: any) => {
          if (transactionId != cartData.current.pendingTransactionId) {
            return
          }
          let error = e as any
          let errorType = CheckoutTransactionError.Unknown
          if (error?.message && error?.message.includes('ETH balance')) {
            errorType = CheckoutTransactionError.InsufficientBalance
          } else if (error?.code && error?.code == 4001) {
            errorType = CheckoutTransactionError.UserDenied
          } else {
            let message = 'Oops, something went wrong. Please try again.'
            if (error?.type && error?.type === 'price mismatch') {
              errorType = CheckoutTransactionError.PiceMismatch
              message = error.message
            }

            //@ts-ignore: Should be fixed in an update to typescript
            error = new Error(message, {
              cause: error,
            })
          }
          if (cartData.current.transaction) {
            cartData.current.transaction.status = CheckoutStatus.Idle
            cartData.current.transaction.error = error
            cartData.current.transaction.errorType = errorType
            if (
              cartData.current.chain?.id ==
              cartData.current.transaction.chain.id
            ) {
              const items = [...cartData.current.transaction.items]
              const pools = calculatePools(items)
              const currency = getCartCurrency(
                items,
                cartData.current.transaction.chain.id
              )
              const { totalPrice, referrerFee } = calculatePricing(
                items,
                currency,
                cartData.current.referrerFeeBps
              )
              cartData.current.items = items
              cartData.current.pools = pools
              cartData.current.currency = currency
              cartData.current.totalPrice = totalPrice
              cartData.current.referrerFee = referrerFee
              cartData.current.chain = cartData.current.transaction.chain
            }
            commit()
            validate()
          }
        })
    },
    [client, switchNetworkAsync]
  )

  return {
    get,
    set,
    subscribe,
    setQuantity,
    add,
    remove,
    clear,
    clearTransaction,
    validate,
    checkout,
  }
}

export const CartContext = createContext<ReturnType<typeof cartStore> | null>(
  null
)

type CartProviderProps = {
  children: ReactNode
  referrer?: string
  referrerFeeBps?: number
  persist?: boolean
}

export const CartProvider: FC<CartProviderProps> = function ({
  children,
  referrer,
  referrerFeeBps,
  persist,
}) {
  return (
    <CartContext.Provider
      value={cartStore({ referrer, referrerFeeBps, persist })}
    >
      {children}
    </CartContext.Provider>
  )
}
