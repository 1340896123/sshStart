import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const repository = "1340896123/sshStart";
const destination = new URL("../public/downloads/", import.meta.url);
const headers = {
  "User-Agent": "sshStar-website-release-sync",
  Accept: "application/vnd.github+json",
};
if (process.env.GITHUB_TOKEN)
  headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

async function request(url, options = {}) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(60000),
    ...options,
  });
  if (!response.ok)
    throw new Error(`Release request failed: HTTP ${response.status}`);
  return response;
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function assetUrl(asset, tag) {
  const expected = `https://github.com/${repository}/releases/download/${tag}/${asset.name}`;
  if (
    asset.browser_download_url !== expected ||
    !/^[A-Za-z0-9_.-]+$/.test(asset.name)
  ) {
    throw new Error("Unexpected GitHub release asset URL");
  }
  return expected;
}

const release = await (
  await request(`https://api.github.com/repos/${repository}/releases/latest`, {
    headers,
  })
).json();
if (
  !/^v\d+\.\d+\.\d+$/.test(release.tag_name) ||
  release.draft ||
  release.prerelease
)
  throw new Error("Expected a stable semantic release");
const version = release.tag_name.slice(1);
const metadataPath = new URL("../src/release.json", import.meta.url);
const previous = JSON.parse(await readFile(metadataPath, "utf8"));
if (previous.version !== version) {
  throw new Error(
    `Latest release is ${version}. Update the release notes in index.html and src/release.json before syncing a new version.`,
  );
}
const exe = release.assets.find(
  (asset) => asset.name === `sshStar_${version}_x64-setup.exe`,
);
const msi = release.assets.find(
  (asset) => asset.name === `sshStar_${version}_x64_en-US.msi`,
);
const sums = release.assets.find((asset) => asset.name === "SHA256SUMS.txt");
if (!exe || !msi || !sums)
  throw new Error("Release must include EXE, MSI and SHA256SUMS.txt");

await mkdir(destination, { recursive: true });
const checksums = await (
  await request(assetUrl(sums, release.tag_name))
).text();
const expectedHashes = new Map(
  checksums
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^([a-fA-F0-9]{64})\s+\*?([A-Za-z0-9_.-]+)$/);
      if (!match) throw new Error("Invalid release checksum file");
      return [match[2], match[1].toLowerCase()];
    }),
);

async function syncAsset(asset) {
  const url = assetUrl(asset, release.tag_name);
  const expected = expectedHashes.get(asset.name);
  if (!expected || asset.digest !== `sha256:${expected}`)
    throw new Error(`Checksum metadata mismatch: ${asset.name}`);
  const target = fileURLToPath(new URL(asset.name, destination));
  const valid = async () =>
    (await stat(target)).size === asset.size &&
    (await sha256(target)) === expected;
  if (!(await valid().catch(() => false))) {
    const temporary = `${target}.part`;
    console.log(`Downloading ${asset.name} (${asset.size} bytes)`);
    const response = await request(url);
    if (!response.body) throw new Error("Empty download body");
    await pipeline(
      Readable.fromWeb(response.body),
      createWriteStream(temporary),
    );
    if (
      (await stat(temporary)).size !== asset.size ||
      (await sha256(temporary)) !== expected
    )
      throw new Error(`Download verification failed: ${asset.name}`);
    await rename(temporary, target);
  }
  console.log(`SHA-256 verified: ${asset.name}`);
  return { name: asset.name, size: asset.size, sha256: expected };
}

const exeMetadata = await syncAsset(exe);
const msiMetadata = await syncAsset(msi);
await writeFile(new URL("SHA256SUMS.txt", destination), checksums);
const metadata = {
  version,
  date: release.published_at.slice(0, 10),
  url: `https://github.com/${repository}/releases/tag/${release.tag_name}`,
  exe: exeMetadata,
  msi: msiMetadata,
};
await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
console.log(`Release v${version} ready for website build.`);
