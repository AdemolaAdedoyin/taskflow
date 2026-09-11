export class AppError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public code: string,
    public details?: unknown
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id: string) {
    super(`${resource} '${id}' not found`, 404, "NOT_FOUND");
  }
}

export class ValidationError extends AppError {
  constructor(details: unknown) {
    super("Request failed validation", 422, "VALIDATION_ERROR", details);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, "CONFLICT");
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Missing or invalid API key") {
    super(message, 401, "UNAUTHORIZED");
  }
}
