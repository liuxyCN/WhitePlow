import axios from "axios";
import fs from "fs";
import path from "path";

interface FileCoolConfig {
  apiUrl?: string;
  apiKey?: string;
}

async function processFiles(inputFiles: string[], functionType: string, config?: FileCoolConfig) {
  if (!config?.apiUrl) {
    throw new Error("MCP Gateway URL is required. Please configure it in MCP settings.");
  }

  if (!config?.apiKey) {
    throw new Error("MCP Gateway API Key is required. Please configure it in MCP settings.");
  }

  const API_URL = config.apiUrl + 'file-cool';
  const API_KEY = config.apiKey;

  console.log(`File-cool client using API_URL: ${API_URL}, API_KEY: [REDACTED]`);
  try {
    // 创建 FormData
    const formData = new FormData();

    // 添加 functionType
    formData.append("functionType", functionType);

    // 读取并添加所有输入文件
    for (const filePath of inputFiles) {
      const fileBuffer = await fs.promises.readFile(filePath);
      const fileName = path.basename(filePath);

      // 创建 Blob 对象
      const blob = new Blob([fileBuffer], { type: "application/octet-stream" });

      // 添加到 FormData
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

        // 查找对应的输入文件路径
        const correspondingInputFile = inputFiles.find((inputFile) => {
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

        // 如果找到对应的输入文件，使用其目录路径；否则使用第一个输入文件的目录
        const outputDir = correspondingInputFile
          ? path.dirname(correspondingInputFile)
          : path.dirname(inputFiles[0]);

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

main();
