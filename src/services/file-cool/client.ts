import axios from "axios";
import fs from "fs";
import path from "path";
import { getWorkspacePath } from "../../utils/path";

interface FileCoolConfig {
  apiUrl?: string;
  apiKey?: string;
}

async function processFiles(inputs: string[], functionType: string, config?: FileCoolConfig) {
  if (!config?.apiUrl) {
    throw new Error("MCP Gateway URL is required. Please configure it in MCP settings.");
  }

  if (!config?.apiKey) {
    throw new Error("MCP Gateway API Key is required. Please configure it in MCP settings.");
  }

  const API_URL = config.apiUrl + '/file-cool';
  const API_KEY = config.apiKey;

  console.log(`File-cool client using API_URL: ${API_URL}, API_KEY: [REDACTED]`);
  try {
    // 创建 FormData
    const formData = new FormData();

    // 添加 functionType
    formData.append("functionType", functionType);

    // 判断是否为URL的正则表达式
    const urlPattern = /^https?:\/\//i;

    // 分别处理文件路径和URL
    const filePaths: string[] = [];
    const urls: string[] = [];

    for (const input of inputs) {
      if (urlPattern.test(input)) {
        // 如果是URL，直接添加到URL数组
        urls.push(input);
      } else {
        // 如果是文件路径，添加到文件路径数组
        filePaths.push(input);
      }
    }

    // 添加URL字符串（如果存在）- 使用多次 append 以保持与文件处理方式一致
    for (const url of urls) {
      formData.append("inputUrls", url);
    }

    // 读取并添加所有本地文件
    for (const filePath of filePaths) {
      const fileBuffer = await fs.promises.readFile(filePath);
      const fileName = path.basename(filePath);

      // 创建 Blob 对象（将 Buffer 转换为 Uint8Array）
      const blob = new Blob([new Uint8Array(fileBuffer)], { type: "application/octet-stream" });

      // 添加到 FormData - 多次 append 同一个字段名，后端会解析为数组
      formData.append("inputFiles", blob, fileName);
    }

    // 发送 multipart 请求到 API
    const response = await axios.post(API_URL, formData, {
      headers: {
        "Content-Type": "multipart/form-data",
        "API_KEY": API_KEY,
      },
    });

    // 返回响应数据
    const result = response.data;

    if (result && result.length > 0) {
      for (const _data of result) {
        const _filename = _data.filename;
        const _files = _data.result;

        // 查找对应的输入文件路径（仅处理本地文件路径）
        const urlPattern = /^https?:\/\//i;
        const localInputs = inputs.filter(input => !urlPattern.test(input));
        const urlInputs = inputs.filter(input => urlPattern.test(input));
        
        const correspondingInputFile = localInputs.find((inputFile) => {
          const inputFileName = path.basename(
            inputFile,
            path.extname(inputFile)
          );
          const outputFileName = path.basename(
            _filename,
            path.extname(_filename)
          );
          return inputFileName === outputFileName;
        });

        // 确定输出目录：
        // 1. 如果找到对应的本地输入文件，使用其目录路径
        // 2. 如果对应的是 URL 输入（找不到对应本地文件且存在 URL 输入），或只有 URL 输入，使用工作区目录
        // 3. 否则使用第一个本地输入文件的目录
        const workspacePath = getWorkspacePath();
        const outputDir = correspondingInputFile
          ? path.dirname(correspondingInputFile)
          : urlInputs.length > 0 || localInputs.length === 0
          ? workspacePath
          : path.dirname(localInputs[0]);

        for (const _file of _files) {
          const _blob = _file.blob;
          const _fileBuffer = Buffer.from(_blob, "base64");
          const fullPath = path.join(outputDir, _file.filename);
          const dirPath = path.dirname(fullPath);

          // 检查并创建目录（如果不存在）
          await fs.promises.mkdir(dirPath, { recursive: true });

          await fs.promises.writeFile(fullPath, _fileBuffer);
        }
      }
    }

    return "success";
  } catch (error) {
    console.error("Error processing files:", error);
    return "failed";
  }
}

async function main() {
  // Example usage - in real usage, config should come from GlobalSettings
  const config = {
    apiUrl: "http://localhost:3000/mcp/",
    apiKey: "your-api-key-here"
  };
  const result = await processFiles(["./test.pdf"], "paddle", config);
  console.log(result);
}

export { processFiles };

// main();
