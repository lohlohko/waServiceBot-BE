import { serverError } from '../utils/response.js';

const errorHandler = (err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  const message = err?.message || 'Internal server error';
  return serverError(res, message);
};

export default errorHandler;
