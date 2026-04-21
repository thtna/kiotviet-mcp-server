import { Octokit } from "@octokit/rest";
import fs from "fs";
import path from "path";

// Lấy mã token từ biến môi trường (antigravity mcp_config.json)
const GITHUB_TOKEN = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
const octokit = new Octokit({ auth: GITHUB_TOKEN });
const REPO_NAME = "kiotviet-invoice-vault";

export async function uploadInvoiceToVault(filePath: string, retailer: string = "unclassified"): Promise<string> {
  if (!GITHUB_TOKEN) {
    throw new Error("Không tìm thấy GITHUB_PERSONAL_ACCESS_TOKEN trong cấu hình MCP.");
  }

  if (!fs.existsSync(filePath)) {
    throw new Error(`File không tồn tại: ${filePath}`);
  }

  const fileContent = fs.readFileSync(filePath, { encoding: "base64" });
  const fileName = path.basename(filePath);
  
  // Tạo đường dẫn trong repo chuyên nghiệp: [GianHang]/[Nam]/[Thang]/[TenFile]
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  
  const repoPath = `${retailer}/${year}/${month}/${day}_${Date.now()}_${fileName}`;

  const { data: user } = await octokit.users.getAuthenticated();
  const owner = user.login;

  // 4. Kiểm tra repo đã có chưa, nếu chưa thì tạo mới (Private)
  try {
    await octokit.repos.get({ owner, repo: REPO_NAME });
  } catch (error: any) {
    if (error.status === 404) {
      console.warn(`[Vault] Repo ${REPO_NAME} chưa tồn tại, đang tự động tạo (Private)...`);
      await octokit.repos.createForAuthenticatedUser({
        name: REPO_NAME,
        private: true,
        auto_init: true,
        description: "Kho lưu trữ ảnh hóa đơn KiotViet bí mật do Antigravity quản lý"
      });
      // Đợi 1 chút cho repo khởi tạo xong
      await new Promise(r => setTimeout(r, 2000));
    } else {
      throw error;
    }
  }

  // 5. Đẩy file lên GitHub
  console.log(`[Vault] Đang tải file lên ${owner}/${REPO_NAME}/${repoPath}...`);
  const response = await octokit.repos.createOrUpdateFileContents({
    owner,
    repo: REPO_NAME,
    path: repoPath,
    message: `Thêm hóa đơn tự động: ${fileName}`,
    content: fileContent
  });

  console.log(`[Vault] Đã lưu hóa đơn bình yên vô sự tại GitHub!`);
  return response.data.content?.html_url || "";
}
