import crypto from "node:crypto";
import axios from "axios";
import { db } from "../_core/db";

export type YtoConfig = {
  id: number;
  courierCode: string;
  name: string;
  baseUrl: string;
  appKey: string;
  appSecret: string;
  customerCode: string | null;
  enabled: number;
};

function stableStringify(obj: any): string {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(",")}]`;
  const keys = Object.keys(obj).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

function mask(value: string | null | undefined): string {
  if (!value) return "";
  if (value.length <= 6) return "*".repeat(value.length);
  return `${value.slice(0, 3)}***${value.slice(-3)}`;
}

export class YuantongService {
  async getConfig() {
    const [[row]] = await db.query<any[]>(
      `SELECT id, courier_code AS courierCode, name, base_url AS baseUrl,
              app_key AS appKey, app_secret AS appSecret, customer_code AS customerCode,
              enabled
       FROM courier_integrations
       WHERE courier_code='yto'
       LIMIT 1`
    );

    return (row as YtoConfig | undefined) || null;
  }

  async saveConfig(input: {
    baseUrl: string;
    appKey: string;
    appSecret?: string;
    customerCode?: string;
    enabled: boolean;
  }) {
    const existing = await this.getConfig();
    const appSecret = input.appSecret?.trim() || existing?.appSecret || "";

    await db.query(
      `INSERT INTO courier_integrations(courier_code, name, base_url, app_key, app_secret, customer_code, enabled)
       VALUES('yto', '圆通快递', :baseUrl, :appKey, :appSecret, :customerCode, :enabled)
       ON DUPLICATE KEY UPDATE
         name=VALUES(name),
         base_url=VALUES(base_url),
         app_key=VALUES(app_key),
         app_secret=VALUES(app_secret),
         customer_code=VALUES(customer_code),
         enabled=VALUES(enabled),
         updated_at=NOW()`,
      {
        baseUrl: input.baseUrl.trim(),
        appKey: input.appKey.trim(),
        appSecret,
        customerCode: input.customerCode?.trim() || null,
        enabled: input.enabled ? 1 : 0,
      }
    );

    return this.getConfigMasked();
  }

  async getConfigMasked() {
    const cfg = await this.getConfig();
    if (!cfg) return null;
    return {
      ...cfg,
      appKeyMask: mask(cfg.appKey),
      appSecretMask: mask(cfg.appSecret),
      appSecret: undefined,
    };
  }

  sign(payload: any, method: string, v: string, appSecret: string, appKey: string) {
    const paramStr = stableStringify(payload);
    const signBase = `${appKey}${method}${v}${paramStr}${appSecret}`;
    return crypto.createHash("md5").update(signBase, "utf8").digest("hex").toUpperCase();
  }

  async request(input: {
    apiPath?: string;
    method: string;
    bizType: string;
    bizId: string;
    payload: Record<string, any>;
  }) {
    const cfg = await this.getConfig();
    if (!cfg || !cfg.enabled) {
      return { ok: false, error: "YTO integration disabled" };
    }

    const v = "1.0";
    const url = `${cfg.baseUrl.replace(/\/$/, "")}${input.apiPath || ""}`;
    const sign = this.sign(input.payload, input.method, v, cfg.appSecret, cfg.appKey);
    const body = {
      method: input.method,
      v,
      app_key: cfg.appKey,
      customer_code: cfg.customerCode || undefined,
      sign,
      param: JSON.stringify(input.payload),
    };

    let httpStatus: number | null = null;
    let responseBody: any = null;
    let success = 0;
    let errorMessage: string | null = null;

    try {
      const resp = await axios.post(url, body, { timeout: 10000 });
      httpStatus = resp.status;
      responseBody = resp.data;
      success = resp.status >= 200 && resp.status < 300 ? 1 : 0;
      if (!success) errorMessage = `HTTP ${resp.status}`;
    } catch (err: any) {
      httpStatus = err?.response?.status || null;
      responseBody = err?.response?.data || null;
      success = 0;
      errorMessage = String(err?.message || "request failed");
    }

    await db.query(
      `INSERT INTO courier_api_logs(
        courier_code, biz_type, biz_id, request_url, request_body,
        response_body, http_status, success, error_message, created_at
      ) VALUES(
        'yto', :bizType, :bizId, :requestUrl, :requestBody,
        :responseBody, :httpStatus, :success, :errorMessage, NOW()
      )`,
      {
        bizType: input.bizType,
        bizId: input.bizId,
        requestUrl: url,
        requestBody: JSON.stringify({ ...body, app_key: mask(cfg.appKey), sign: "***", app_secret: "***" }),
        responseBody: responseBody ? JSON.stringify(responseBody) : null,
        httpStatus,
        success,
        errorMessage,
      }
    );

    if (success) return { ok: true, data: responseBody };
    return { ok: false, error: errorMessage || "request failed", data: responseBody };
  }

  async pushReturnOrder(input: {
    bizId: string;
    waybillNo: string | null;
    receiverName: string | null;
    receiverPhone: string | null;
    receiverAddress: string | null;
    receiverCountry: string | null;
  }) {
    const payload = {
      orderNo: input.bizId,
      waybillNo: input.waybillNo,
      receiverName: input.receiverName,
      receiverPhone: input.receiverPhone,
      receiverAddress: input.receiverAddress,
      receiverCountry: input.receiverCountry,
      reason: "客户退件",
    };

    return this.request({
      method: "yto.return.order.push",
      bizType: "return_order",
      bizId: input.bizId,
      payload,
    });
  }
}

export const yuantongService = new YuantongService();
