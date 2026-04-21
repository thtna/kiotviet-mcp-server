import axios, { AxiosError } from "axios";
import { getCredentials } from "./credentials.js";

// HỆ THỐNG MIỄN DỊCH KIOTVIET BẢO MẬT
// Tự động cấp lại Token, tự động thử lại khi lỗi mạng

let currentAccessToken: string | null = null;
let tokenExpiresAt: number = 0;

export async function refreshKiotVietToken(): Promise<string> {
  const creds = getCredentials();
  if (!creds) {
    throw new Error("CHƯA CẤU HÌNH KIOTVIET: Xin vui lòng dùng lệnh kv_setup_credentials trước.");
  }

  const { clientId, clientSecret } = creds;
  const tokenUrl = "https://id.kiotviet.vn/connect/token";
  const data = new URLSearchParams();
  data.append("scopes", "PublicApi.Access");
  data.append("grant_type", "client_credentials");
  data.append("client_id", clientId);
  data.append("client_secret", clientSecret);

  try {
    const response = await axios.post(tokenUrl, data, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    
    currentAccessToken = response.data.access_token;
    // expires_in là số giây, ta cộng vào thời gian hiện tại (trừ hao 60s để an toàn)
    tokenExpiresAt = Date.now() + (response.data.expires_in - 60) * 1000;
    
    console.warn("[HỆ MIỄN DỊCH] Đã cấp mới Access Token KiotViet thành công.");
    return currentAccessToken!;
  } catch (error: any) {
    const errMsg = error.response?.data?.message || error.message;
    console.error("[HỆ MIỄN DỊCH] Lỗi cấp Token:", errMsg);
    throw new Error(`KHÔNG THỂ LẤY TOKEN: Kiểm tra lại Client ID và Client Secret. Lỗi: ${errMsg}`);
  }
}

export async function getValidToken(): Promise<string> {
  if (!currentAccessToken || Date.now() > tokenExpiresAt) {
    console.warn("[HỆ MIỄN DỊCH] Token đã hết hạn hoặc chưa có, đang tự động xin cấp lại...");
    return await refreshKiotVietToken();
  }
  return currentAccessToken;
}

// Bác sĩ chẩn đoán (Resilient Fetcher)
export async function resilientKiotVietAPI<T>(
  method: "GET" | "POST" | "PUT",
  endpoint: string, // e.g., "/products?pageSize=10"
  data?: any
): Promise<T> {
  const creds = getCredentials();
  if (!creds) throw new Error("Chưa cấu hình KiotViet.");

  let token = await getValidToken();
  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const url = `https://public.kiotapi.com${endpoint}`;
      const response = await axios({
        method,
        url,
        headers: {
          "Retailer": creds.retailer,
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
        // Token lỗi hoặc hết hạn bất thình lình -> Xóa token và xin lại
        console.warn("[HỆ MIỄN DỊCH] Bắt được lỗi 401 Unauthorized. Tiến hành Refresh Token khẩn cấp!");
        token = await refreshKiotVietToken();
        continue; // Thử lại ngay với token mới
      }

      if (status === 429) {
        // Rate limit: KiotViet giới hạn số lượng request
        const waitMs = 2000 * attempt; 
        console.warn(`[HỆ MIỄN DỊCH] Rate Limit! Bị chặn tốc độ. Đợi ${waitMs}ms rồi thử lại...`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
        continue;
      }

      if (!status || status >= 500) {
        // Lỗi mạng hoặc lỗi server KiotViet
         console.warn(`[HỆ MIỄN DỊCH] Lỗi kết nối máy chủ / Mất mạng. Đợi 1 giây để thử lại...`);
         await new Promise(resolve => setTimeout(resolve, 1000));
         continue;
      }

      // Các lỗi 400 (Bad Request), 404 (Not Found)... không thể tự phục hồi bằng retry
      throw new Error(`[Lỗi Dữ liệu] KiotViet từ chối yêu cầu (HTTP ${status}): ${errMsg}`);
    }
  }

  throw new Error(`[QUARANTINE] KiotViet API thất bại hoàn toàn sau ${maxRetries} lần thử bảo vệ.`);
}
