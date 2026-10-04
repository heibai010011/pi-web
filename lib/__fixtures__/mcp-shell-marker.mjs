// Invoked through the SDK's !command resolver on both cmd.exe and POSIX shells.
import { writeFileSync } from "node:fs";
const [marker, value] = process.argv.slice(2).map((arg) => Buffer.from(arg, "base64").toString());
writeFileSync(marker, "ran");
process.stdout.write(value);
