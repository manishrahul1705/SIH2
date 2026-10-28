import { logger } from "../config/logger.js";

export function notFoundHandler(req, res) {
  res.status(404).json({
    data: null,
    error: { code: "NOT_FOUND", message: `No route for ${req.method} ${req.path}` },
    meta: { requestId: req.id },
  });
}

export function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  const status = Number.isInteger(error.status) ? error.status : 500;
  const code = error.code || (status === 500 ? "INTERNAL_ERROR" : "REQUEST_ERROR");
  if (status >= 500) logger.error({ err: error, requestId: req.id }, "Request failed");
  else logger.warn({ code, message: error.message, requestId: req.id }, "Request rejected");
  res.status(status).json({
    data: null,
    error: {
      code,
      message: status >= 500 ? "An unexpected server error occurred" : error.message,
      ...(error.details ? { details: error.details } : {}),
    },
    meta: { requestId: req.id },
  });
}
