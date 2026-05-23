import xlsx from "xlsx";
import { db } from "../db.js";
import leadService from "./lead.service.js";

function pick(row, k) {
  return String(row?.[k] ?? "").trim();
}

/**
 * xlsx 中文表头映射
 * 必填：公司名
 * brands：多个用 ; 分隔
 */
function mapRow(row) {
  return {
    company_name: pick(row, "公司名"),
    contact_name: pick(row, "联系人"),

    street: pick(row, "街道"),
    house_no: pick(row, "门牌"),
    postal_code: pick(row, "邮编"),
    city: pick(row, "城市"),
    country: pick(row, "国家") || "China",

    unified_code: pick(row, "社会统一号"),
    website: pick(row, "公司网站"),
    brands: pick(row, "品牌"),
    category: pick(row, "品类"),
    amazon_shop_url: pick(row, "亚马逊shop地址"),
    company_profile: pick(row, "公司简介"),

    source: pick(row, "来源") || "Amazon",
    priority: pick(row, "优先级") || "Normal",

    // 兼容列（可选）
    email: pick(row, "邮箱"),
    phone: pick(row, "电话"),
    address: pick(row, "地址"),
  };
}

/**
 * 去重策略：
 * 1) unified_code
 * 2) amazon_shop_url
 * 3) company_name + city
 */
async function findDuplicateId(data) {
  if (data.unified_code) {
    const [rows] = await db.query(
      `SELECT id FROM leads WHERE unified_code = :unified_code LIMIT 1`,
      { unified_code: data.unified_code }
    );
    if (rows?.length) return String(rows[0].id);
  }

  if (data.amazon_shop_url) {
    const [rows] = await db.query(
      `SELECT id FROM leads WHERE amazon_shop_url = :amazon_shop_url LIMIT 1`,
      { amazon_shop_url: data.amazon_shop_url }
    );
    if (rows?.length) return String(rows[0].id);
  }

  const [rows] = await db.query(
    `SELECT id
     FROM leads
     WHERE company_name = :company_name
       AND IFNULL(city,'') = :city
     LIMIT 1`,
    { company_name: data.company_name, city: data.city || "" }
  );

  if (rows?.length) return String(rows[0].id);
  return null;
}

/**
 * 已存在 lead 时：只补空字段（不覆盖已有内容）
 */
async function patchIfEmpty(id, data) {
  await db.query(
    `UPDATE leads SET
      contact_name = IF(contact_name IS NULL OR contact_name='', :contact_name, contact_name),
      email        = IF(email IS NULL OR email='', :email, email),
      phone        = IF(phone IS NULL OR phone='', :phone, phone),
      address      = IF(address IS NULL OR address='', :address, address),

      street       = IF(street IS NULL OR street='', :street, street),
      house_no     = IF(house_no IS NULL OR house_no='', :house_no, house_no),
      postal_code  = IF(postal_code IS NULL OR postal_code='', :postal_code, postal_code),
      city         = IF(city IS NULL OR city='', :city, city),
      country      = IF(country IS NULL OR country='', :country, country),

      unified_code    = IF(unified_code IS NULL OR unified_code='', :unified_code, unified_code),
      website         = IF(website IS NULL OR website='', :website, website),
      category        = IF(category IS NULL OR category='', :category, category),
      amazon_shop_url = IF(amazon_shop_url IS NULL OR amazon_shop_url='', :amazon_shop_url, amazon_shop_url),
      company_profile = IF(company_profile IS NULL OR company_profile='', :company_profile, company_profile),

      source       = IF(source IS NULL OR source='', :source, source),
      priority     = IF(priority IS NULL OR priority='', :priority, priority),

      updated_at = NOW()
     WHERE id = :id`,
    {
      id,
      contact_name: data.contact_name || null,
      email: data.email || null,
      phone: data.phone || null,
      address: data.address || null,

      street: data.street || null,
      house_no: data.house_no || null,
      postal_code: data.postal_code || null,
      city: data.city || null,
      country: data.country || "China",

      unified_code: data.unified_code || null,
      website: data.website || null,
      category: data.category || null,
      amazon_shop_url: data.amazon_shop_url || null,
      company_profile: data.company_profile || null,

      source: data.source || "Amazon",
      priority: data.priority || "Normal",
    }
  );
}

async function importFromXlsx({ user, filePath }) {
  const wb = xlsx.readFile(filePath);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const json = xlsx.utils.sheet_to_json(sheet, { defval: "" });

  const report = { total: json.length, success: 0, failed: 0, skipped: 0 };

  for (const row of json) {
    const data = mapRow(row);

    if (!data.company_name) {
      report.skipped++;
      continue;
    }

    const dupId = await findDuplicateId(data);

    if (!dupId) {
      await leadService.createLead({ user, payload: data });
    } else {
      await patchIfEmpty(dupId, data);

      const brands = leadService.normalizeBrands(data.brands);
      for (const b of brands) {
        await db.query(
          `INSERT IGNORE INTO lead_brands(lead_id, brand_name, created_at)
           VALUES(:lead_id, :brand_name, NOW())`,
          { lead_id: dupId, brand_name: b }
        );
      }
    }

    report.success++;
  }

  return report;
}

export default {
  importFromXlsx,
};
