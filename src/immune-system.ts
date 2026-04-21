import { getAccount } from "./credentials.js";

// HỆ THỐNG MIỄN DỊCH KIOTVIET BẢO MẬT
// Tự động cấp lại Token, chọn Endpoint chuẩn cho Retail/FnB

const tokens = new Map<string, { token: string; expiresAt: number }>();

export async function refreshKiotVietToken(retailer?: string): Promise<string> {
  const account = getAccount(retailer);
  if (!account) {
    throw new Error("CHƯA CẤU HÌNH GIAN HÀNG: Xin vui lòng dùng lệnh kv_setup_credentials trước.");
  }

  const { clientId, clientSecret, type, retailer: name } = account;
  
  // Phân biệt Token URL và Scope theo ngành hàng
  const isFnB = type === "fnb";
  const tokenUrl = isFnB 
    ? "https://api.fnb.kiotviet.vn/identity/connect/token" 
    : "https://id.kiotviet.vn/connect/token";
    
  const scope = isFnB ? "PublicApi.Access.FNB" : "PublicApi.Access";

  const data = new URLSearchParams();
  data.append("scopes", scope);
  data.append("grant_type", "client_credentials");
  data.append("client_id", clientId);
  data.append("client_secret", clientSecret);

  try {
    const response = await axios.post(tokenUrl, data, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    
    const accessToken = response.data.access_token;
    const expiresAt = Date.now() + (response.data.expires_in - 60) * 1000;
    
    tokens.set(name, { token: accessToken, expiresAt });
    
    console.warn(`[HỆ MIỄN DỊCH] Đã cấp mới Access Token cho gian hàng [${name}] thành công.`);
    return accessToken;
  } catch (error: any) {
    const errMsg = error.response?.data?.message || error.message;
    console.error(`[HỆ MIỄN DỊCH] Lỗi cấp Token cho [${name}]:`, errMsg);
    throw new Error(`KHÔNG THỂ LẤY TOKEN: ${errMsg}`);
  }
}

export async function getValidToken(retailer?: string): Promise<string> {
  const account = getAccount(retailer);
  if (!account) throw new Error("Chưa cấu hình gian hàng.");
  
  const tokenData = tokens.get(account.retailer);
  if (!tokenData || Date.now() > tokenData.expiresAt) {
    console.warn(`[HỆ MIỄN DỊCH] Token của [${account.retailer}] đã hết hạn, đang xin cấp lại...`);
    return await refreshKiotVietToken(account.retailer);
  }
  return tokenData.token;
}

// Bác sĩ chẩn đoán (Resilient Fetcher)
export async function resilientKiotVietAPI<T>(
  method: "GET" | "POST" | "PUT",
  endpoint: string, // e.g., "/products?pageSize=10"
  data?: any,
  retailer?: string
): Promise<T> {
  const account = getAccount(retailer);
  if (!account) throw new Error("Chưa cấu hình gian hàng.");

  let token = await getValidToken(account.retailer);
  const maxRetries = 3;

  // Xác định Base URL theo ngành
  const baseUrl = account.type === "fnb" 
    ? "https://publicfnb.kiotapi.com/" 
    : "https://public.kiotapi.com/";

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const url = `${baseUrl}${endpoint.startsWith("/") ? endpoint.substring(1) : endpoint}`;
      const response = await axios({
        method,
        url,
        headers: {
          "Retailer": account.retailer,
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        data
      });
      return response.data;
    } catch (error: any) {
      const status = error.response?.status;
      const errMsg = error.response?.data?.message || error.message;

      console.error(`[Lỗi KiotViet][Lần ${attempt}] Status: ${status} - ${errMsg}`);

      if (status === 401) {
        console.warn("[HỆ MIỄN DỊCH] Bắt được lỗi 401 Unauthorized. Refresh Token khẩn cấp!");
        token = await refreshKiotVietToken(account.retailer);
        continue;
      }

      if (status === 429) {
        const waitMs = 2000 * attempt; 
        console.warn(`[HỆ MIỄN DỊCH] Rate Limit! Đợi ${waitMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
        continue;
      }

      if (!status || status >= 500) {
         console.warn(`[HỆ MIỄN DỊCH] Lỗi máy chủ/mạng. Thử lại sau 1s...`);
         await new Promise(resolve => setTimeout(resolve, 1000));
         continue;
      }

      throw new Error(`[Lỗi Dữ liệu] KiotViet từ chối (HTTP ${status}): ${errMsg}`);
    }
  }

  throw new Error(`[QUARANTINE] KiotViet API thất bại hoàn toàn sau ${maxRetries} lần thử.`);
}
