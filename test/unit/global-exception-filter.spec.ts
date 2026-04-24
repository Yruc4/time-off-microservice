import 'reflect-metadata';
import { ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { GlobalExceptionFilter } from '../../src/common/filters/global-exception.filter';

function makeHost(mockResponse: Partial<{ status: jest.Mock; json: jest.Mock }>) {
  const json = mockResponse.json ?? jest.fn();
  const status = mockResponse.status ?? jest.fn().mockReturnValue({ json });
  const response = { status, json };
  const request = { method: 'POST', url: '/api/time-off/request' };

  return {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => request,
    }),
  } as unknown as ArgumentsHost;
}

describe('GlobalExceptionFilter', () => {
  let filter: GlobalExceptionFilter;
  let jsonMock: jest.Mock;
  let statusMock: jest.Mock;
  let host: ArgumentsHost;

  beforeEach(() => {
    filter = new GlobalExceptionFilter();
    jsonMock = jest.fn();
    statusMock = jest.fn().mockReturnValue({ json: jsonMock });
    host = makeHost({ status: statusMock, json: jsonMock });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // HttpException variants
  // ────────────────────────────────────────────────────────────────────────────

  it('HttpException (400) → 400 with HTTP_EXCEPTION code', () => {
    filter.catch(new HttpException('Bad input', HttpStatus.BAD_REQUEST), host);

    expect(statusMock).toHaveBeenCalledWith(400);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 400, code: 'HTTP_EXCEPTION', message: 'Bad input' }),
    );
  });

  it('HttpException (503) → 503 with HTTP_EXCEPTION code', () => {
    filter.catch(
      new HttpException('Service unavailable', HttpStatus.SERVICE_UNAVAILABLE),
      host,
    );

    expect(statusMock).toHaveBeenCalledWith(503);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 503, code: 'HTTP_EXCEPTION' }),
    );
  });

  it('HttpException with object body → extracts message field', () => {
    filter.catch(
      new HttpException({ message: 'Validation failed', extra: 'data' }, HttpStatus.BAD_REQUEST),
      host,
    );

    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Validation failed' }),
    );
  });

  // ────────────────────────────────────────────────────────────────────────────
  // QueryFailedError variants
  // ────────────────────────────────────────────────────────────────────────────

  it('QueryFailedError with UNIQUE constraint → 409 DUPLICATE_REQUEST_ID', () => {
    const err = new QueryFailedError('INSERT', [], new Error('UNIQUE constraint failed: time_off_requests.request_id'));
    filter.catch(err, host);

    expect(statusMock).toHaveBeenCalledWith(409);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 409,
        code: 'DUPLICATE_REQUEST_ID',
        message: expect.stringMatching(/Duplicate request_id/i),
      }),
    );
  });

  it('QueryFailedError (non-unique) → 500 DATABASE_ERROR', () => {
    const err = new QueryFailedError('SELECT', [], new Error('some other db error'));
    filter.catch(err, host);

    expect(statusMock).toHaveBeenCalledWith(500);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 500, code: 'DATABASE_ERROR' }),
    );
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Optimistic lock error
  // ────────────────────────────────────────────────────────────────────────────

  it('OptimisticLockVersionMismatchError (by class name) → 409 OPTIMISTIC_LOCK_CONFLICT', () => {
    const err = new Error('optimistic lock version mismatch');
    Object.defineProperty(err, 'constructor', { value: { name: 'OptimisticLockVersionMismatchError' } });
    filter.catch(err, host);

    expect(statusMock).toHaveBeenCalledWith(409);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 409, code: 'OPTIMISTIC_LOCK_CONFLICT' }),
    );
  });

  it('Error with "optimistic lock" in message → 409 OPTIMISTIC_LOCK_CONFLICT', () => {
    filter.catch(new Error('optimistic lock version mismatch detected'), host);

    expect(statusMock).toHaveBeenCalledWith(409);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 409, code: 'OPTIMISTIC_LOCK_CONFLICT' }),
    );
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Unknown / generic errors
  // ────────────────────────────────────────────────────────────────────────────

  it('unknown Error → 500 INTERNAL_ERROR', () => {
    filter.catch(new Error('something unexpected'), host);

    expect(statusMock).toHaveBeenCalledWith(500);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 500, code: 'INTERNAL_ERROR' }),
    );
  });

  it('non-Error thrown value (string) → 500 INTERNAL_ERROR', () => {
    filter.catch('some string thrown', host);

    expect(statusMock).toHaveBeenCalledWith(500);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 500, code: 'INTERNAL_ERROR' }),
    );
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Response shape
  // ────────────────────────────────────────────────────────────────────────────

  it('response always includes path and timestamp fields', () => {
    filter.catch(new HttpException('test', HttpStatus.BAD_REQUEST), host);

    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/api/time-off/request',
        timestamp: expect.any(String),
      }),
    );
  });
});
