const options =
  'Connect a key from the original Garmin account, delete all imported Garmin data in Settings and connect another account, or create a separate Running Coach account through an invitation.'

export function garminAccountIssueMessage(code: string | null): string | null {
  if (code === 'ACCOUNT_MISMATCH' || code === 'ACCOUNT_ALREADY_LINKED')
    return `This Garmin account does not match the saved association or is linked to another Running Coach user. ${options}`
  if (code === 'ACCOUNT_UNVERIFIABLE' || code === 'UNVERIFIABLE')
    return `Garmin account identity could not be verified. The existing connection and imported data were kept. ${options}`
  return null
}
