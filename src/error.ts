export class ErrorWithCause extends Error {
  constructor(public readonly message: string, public readonly cause?: unknown) {
    super(message);
  }
}
