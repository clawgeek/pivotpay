import {
  Catch,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { DomainError } from '../shared/kernel';

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<{
      status(code: number): { json(body: unknown): void };
    }>();
    const error = exception as {
      message?: string;
      status?: number;
      statusCode?: number;
      code?: string;
    };
    const isDomain = exception instanceof DomainError;
    const status = isDomain
      ? (exception as DomainError).httpStatus
      : (error?.status ?? error?.statusCode ?? 500);
    const code = isDomain
      ? (exception as DomainError).code
      : (error?.code ?? 'INTERNAL_ERROR');
    const message = error?.message ?? 'Internal server error';
    if (status >= 500) {
      console.error(`[${code}] ${message}`);
    }
    response.status(status).json({ ok: false, code, message });
  }
}
