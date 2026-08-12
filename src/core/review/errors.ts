export class ReviewError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: 400 | 404 | 409 | 413 | 415 | 422,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ReviewError";
  }
}
