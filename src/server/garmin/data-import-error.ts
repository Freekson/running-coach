export class GarminDataImportError extends Error {
  constructor(
    readonly code:
      | 'NOT_CONNECTED'
      | 'APPROVAL_REQUIRED'
      | 'BUSY'
      | 'RATE_LIMITED'
      | 'INVALID_TIMEZONE'
      | 'INVALID_CHECKPOINT'
      | 'NOT_STARTED'
      | 'NOT_READY',
  ) {
    super(code)
  }
}
