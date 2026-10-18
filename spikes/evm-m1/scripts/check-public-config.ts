import { parsePublicConfig, publicConfigSummary, PublicConfigError } from "../src/public-config.js";

const args = process.argv.slice(2);
const execute = args.length === 1 && args[0] === "--execute";
if (args.length > 0 && !execute) {
  process.stdout.write('{"ok":false,"code":"invalid_arguments"}\n');
  process.exitCode = 2;
} else {
  try {
    const config = parsePublicConfig(process.env, { execute });
    process.stdout.write(`${JSON.stringify({ ok: true, code: "config_valid", ...publicConfigSummary(config) })}\n`);
  } catch (error) {
    if (error instanceof PublicConfigError) {
      process.stdout.write(`${JSON.stringify({ ok: false, code: error.code, missing: error.missing })}\n`);
    } else {
      process.stdout.write('{"ok":false,"code":"configuration_unavailable"}\n');
    }
    process.exitCode = 1;
  }
}
