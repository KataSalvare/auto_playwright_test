import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { automationConfig } from '../automation.config';
import { runOrderFlow } from '../src/automation/order-flow';
import { parseOrderUrl } from '../src/automation/url-config';

type RunnerResult = {
  success: boolean;
  videoPath?: string;
  error?: string;
};

function optionValue(name: string): string | undefined {
  const argument = process.argv.slice(2).find((value) => value.startsWith(`${name}=`));
  return argument?.slice(name.length + 1);
}

async function writeResult(resultFile: string | undefined, result: RunnerResult) {
  if (!resultFile) return;
  await mkdir(dirname(resultFile), { recursive: true });
  await writeFile(resultFile, JSON.stringify(result, null, 2), 'utf8');
}

function failureVideoPath(message: string): string | undefined {
  return message.match(/失败视频：([^\n]+)/)?.[1];
}

async function main() {
  const [targetUrl] = process.argv.slice(2).filter((argument) => !argument.startsWith('--'));
  const resultFile = optionValue('--result-file');
  const outputDir = resolve(optionValue('--output-dir') || 'output/quick-test-videos');
  if (!targetUrl) throw new Error('快速测试执行器缺少业务链接');

  try {
    const order = parseOrderUrl(targetUrl);
    const result = await runOrderFlow(order, {
      seed: Number(optionValue('--seed')) || Date.now(),
      product: 'basic',
      waitAgreement: true,
      waitProduct: true,
      headless: true,
      deleteFailedVideo: automationConfig.deleteFailedVideo,
      outputDir,
    });
    await writeResult(resultFile, { success: true, videoPath: result.videoPath });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeResult(resultFile, { success: false, error: message, videoPath: failureVideoPath(message) });
    throw error;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
