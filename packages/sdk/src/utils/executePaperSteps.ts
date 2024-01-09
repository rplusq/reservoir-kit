import { getClient } from '../actions'
import { isAxiosError } from './axios'
import { LogLevel } from './logger'
import { pollUntilHasData } from './pollApi'

interface PaperTransactionResult {
  result: {
    transactionId: string
    checkoutId: string
    contractId: string
    status: PaperTransactionStatus
    transactionHash: string
    hasPaymentError: boolean
    isPaymentSubmitted: boolean
    isPaymentReceived: boolean
    isNFTDelivered: boolean
    claimedTokens: {
      tokens: {
        tokenId: string
        quantity: number
        transferHash: string
        transferExplorerUrl: string
      }[]
      collectionTitle: string
      collectionAddress: string
    }

    isFreeClaim: boolean
    transferSucceededAt: string
  }
}

type PaperTransactionStatus = 'TRANSFER_SUCCEEDED' | 'PAYMENT_SUCCEEDED'

export async function executePaperSteps(
  transactionId: string,
  clientId: string,
  callback: (
    result: PaperTransactionResult | null,
    status: PaperTransactionStatus | null
  ) => void
) {
  const client = getClient()

  try {
    await pollUntilHasData(
      {
        url: `https://withpaper.com/api/v1/transaction-status/${transactionId}`,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${clientId}`,
          accept: 'application/json',
        },
      },
      (data: PaperTransactionResult): boolean => {
        console.log(data)
        callback(data, data.result.status)
        return data.result.status === 'TRANSFER_SUCCEEDED'
      },
      20, // Max Attempts
      0, // Attempt Count
      10000 // Ms Delay
    )
  } catch (e: unknown) {
    if (isAxiosError(e)) {
      client.log(
        ['Execute Paper Steps: Unexpected Paper API response', e.status],
        LogLevel.Error
      )
    } else {
      client.log(['Execute Paper Steps: Unknown Error', e], LogLevel.Error)
    }
  }
}
