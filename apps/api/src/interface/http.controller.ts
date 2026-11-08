import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { DomainError } from '../shared/kernel';
import { nowIso } from '../shared/kernel';
import { audit } from '../infrastructure/audit';
import { db } from '../infrastructure/database';
import {
  authenticateConsole,
  authenticateMerchant,
  type RequestLike,
} from './auth';
import { paymentService } from '../application/payment.service';
import { consoleService } from '../application/admin.service';

type AnyRequest = RequestLike & { body?: any; headers: any; query?: any; params?: any };

@Controller('api/v1')
export class HttpController {
  // ---------------- 商户开放 API（HMAC 签名） ----------------

  @Post('payments')
  async createPayment(@Req() req: AnyRequest): Promise<unknown> {
    const auth = authenticateMerchant(req);
    const idempotencyKey = String(req.headers['idempotency-key'] || '');
    if (!idempotencyKey) {
      throw new DomainError('IDEMPOTENCY_KEY_REQUIRED', '缺少 Idempotency-Key 请求头', 400);
    }
    const body = req.body || {};
    return paymentService.createPayment({
      tenantId: auth.tenantId,
      appId: auth.appId,
      idempotencyKey,
      request: {
        outTradeNo: String(body.outTradeNo || ''),
        subject: String(body.subject || '商品订单'),
        amountCents: Number(body.amountCents),
        currency: body.currency || 'CNY',
        method: body.method || 'QRCODE',
        notifyUrl: body.notifyUrl,
        clientIp: body.clientIp,
        metadata: body.metadata || {},
        ttlMinutes: Number(body.ttlMinutes || 15),
      },
    });
  }

  @Get('payments')
  listPayments(@Req() req: AnyRequest): unknown {
    const auth = authenticateMerchant(req);
    return paymentService.queryOrders(auth.tenantId, req.query || {});
  }

  @Get('payments/:id')
  getPayment(@Req() req: AnyRequest, @Param('id') id: string): unknown {
    const auth = authenticateMerchant(req);
    return paymentService.getOrder(auth.tenantId, id);
  }

  @Post('payments/:id/refund')
  refundPayment(
    @Req() req: AnyRequest,
    @Param('id') id: string,
    @Body() body: any,
  ): unknown {
    const auth = authenticateMerchant(req);
    return paymentService.refund({
      tenantId: auth.tenantId,
      orderId: id,
      outRefundNo: String(body?.outRefundNo || ''),
      amountCents: Number(body?.amountCents),
      reason: body?.reason,
    });
  }

  @Post('payments/:id/close')
  closePayment(@Req() req: AnyRequest, @Param('id') id: string): unknown {
    const auth = authenticateMerchant(req);
    return paymentService.closeOrder(auth.tenantId, id);
  }

  @Get('refunds')
  listRefunds(@Req() req: AnyRequest): unknown {
    const auth = authenticateMerchant(req);
    return paymentService.queryRefunds(auth.tenantId);
  }

  // ---------------- 通道回调入口（通道侧 HMAC 验签） ----------------

  @Post('channels/callback')
  channelCallback(@Req() req: AnyRequest, @Headers() headers: any): unknown {
    const rawBody =
      typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
    const result = paymentService.handleChannelCallback(rawBody, headers);
    return { ...result, receivedAt: nowIso() };
  }

  // ---------------- SaaS 控制台 API（租户隔离） ----------------

  @Get('console/overview')
  overview(@Req() req: AnyRequest): unknown {
    return consoleService.overview(authenticateConsole(req));
  }

  @Get('console/orders')
  orders(@Req() req: AnyRequest): unknown {
    return paymentService.queryOrders(authenticateConsole(req), req.query || {});
  }

  @Get('console/orders/:id')
  orderDetail(@Req() req: AnyRequest, @Param('id') id: string): unknown {
    return paymentService.getOrder(authenticateConsole(req), id);
  }

  @Post('console/orders/:id/refund')
  refundFromConsole(
    @Req() req: AnyRequest,
    @Param('id') id: string,
    @Body() body: any,
  ): unknown {
    return paymentService.refund({
      tenantId: authenticateConsole(req),
      orderId: id,
      outRefundNo: String(body?.outRefundNo || ''),
      amountCents: Number(body?.amountCents),
      reason: body?.reason,
    });
  }

  @Post('console/orders/:id/close')
  closeFromConsole(@Req() req: AnyRequest, @Param('id') id: string): unknown {
    return paymentService.closeOrder(authenticateConsole(req), id);
  }

  @Get('console/refunds')
  refunds(@Req() req: AnyRequest): unknown {
    return paymentService.queryRefunds(authenticateConsole(req));
  }

  @Get('console/channels')
  channels(@Req() req: AnyRequest): unknown {
    authenticateConsole(req);
    return consoleService.channels();
  }

  @Patch('console/channels/:code')
  updateChannel(
    @Req() req: AnyRequest,
    @Param('code') code: string,
    @Body() body: any,
  ): unknown {
    authenticateConsole(req);
    return consoleService.updateChannel(code, {
      enabled: body?.enabled,
      weight: body?.weight,
      feeBps: body?.feeBps,
      config: body?.config,
    });
  }

  @Get('console/routing')
  routing(@Req() req: AnyRequest): unknown {
    authenticateConsole(req);
    return consoleService.routingPolicy();
  }

  @Post('console/drill')
  drill(@Req() req: AnyRequest, @Body() body: any): unknown {
    authenticateConsole(req);
    return consoleService.injectFault({
      action: String(body?.action || ''),
      channelCode: body?.channelCode,
      value: body?.value,
    });
  }

  @Post('console/sandbox/callback')
  sandboxCallback(@Req() req: AnyRequest, @Body() body: any): unknown {
    return consoleService.simulateCallback({
      tenantId: authenticateConsole(req),
      orderId: String(body?.orderId || ''),
      outcome: body?.outcome === 'FAILURE' ? 'FAILURE' : 'SUCCESS',
      mode: body?.mode || 'normal',
    });
  }

  @Get('console/webhooks')
  webhooks(@Req() req: AnyRequest): unknown {
    return consoleService.webhooks(authenticateConsole(req));
  }

  @Post('console/webhooks/:id/retry')
  retryWebhook(@Req() req: AnyRequest, @Param('id') id: string): unknown {
    return consoleService.retryWebhook(authenticateConsole(req), id);
  }

  @Get('console/reconciliation')
  reconciliation(@Req() req: AnyRequest): unknown {
    return consoleService.reconciliation(authenticateConsole(req));
  }

  @Post('console/reconciliation/run')
  runReconciliation(@Req() req: AnyRequest, @Body() body: any): unknown {
    return consoleService.runReconcile(authenticateConsole(req), body?.date);
  }

  @Get('console/ledger')
  ledger(@Req() req: AnyRequest): unknown {
    return consoleService.ledger(authenticateConsole(req));
  }

  @Get('console/audit')
  auditLog(@Req() req: AnyRequest): unknown {
    return consoleService.auditLog(authenticateConsole(req));
  }

  @Get('console/tenants')
  tenants(@Req() req: AnyRequest): unknown {
    authenticateConsole(req);
    return consoleService.tenants();
  }

  @Get('console/credentials')
  credentials(@Req() req: AnyRequest): unknown {
    return consoleService.credentials(authenticateConsole(req));
  }

  @Get('console/metrics')
  metrics(@Req() req: AnyRequest): unknown {
    authenticateConsole(req);
    return consoleService.metrics();
  }

  // ---------------- 沙箱 Webhook 接收端（真实 HTTP 回环投递） ----------------

  @Post('test/webhook-receiver')
  webhookReceiver(@Headers() headers: any, @Body() body: any): unknown {
    const signature = headers['x-pivotpay-signature'] || '';
    const eventType = headers['x-pivotpay-event'] || 'UNKNOWN';
    audit('system', 'webhook-receiver', 'WEBHOOK_RECEIVED', eventType, {
      signature: String(signature).slice(0, 16),
      eventId: body?.eventId,
      aggregateId: body?.aggregateId,
    });
    return { received: true, eventType, at: nowIso() };
  }
}
