import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

const REPO_ROOT = path.resolve(process.cwd(), "..");
const UPLOADED_DIR = path.join(REPO_ROOT, "contracts", "_uploaded");
const MAX_UPLOAD_BYTES = 1_000_000;

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/\.md$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function sanitizeName(name: string): string {
  const basename = path.basename(name).trim();
  return basename.replace(/[^a-zA-Z0-9._-]/g, "-") || "uploaded-contract.md";
}

export const runtime = "nodejs";

export async function POST(request: Request) {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  const filePart = formData.get("file");
  if (!(filePart instanceof File)) {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }
  if (filePart.size <= 0) {
    return NextResponse.json({ error: "Uploaded file is empty" }, { status: 400 });
  }
  if (filePart.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { error: `File too large (max ${MAX_UPLOAD_BYTES} bytes)` },
      { status: 400 },
    );
  }

  try {
    const originalName = sanitizeName(filePart.name || "uploaded-contract.md");
    const markdown = await filePart.text();
    if (!markdown.trim()) {
      return NextResponse.json({ error: "Uploaded markdown is empty" }, { status: 400 });
    }

    const baseStem = slugify(originalName) || "uploaded-contract";
    const hash = createHash("sha256").update(markdown).digest("hex").slice(0, 8);
    const contractKey = `${baseStem}-${hash}`;
    const sourceFile = `${contractKey}.md`;

    await fs.mkdir(UPLOADED_DIR, { recursive: true });
    await fs.writeFile(path.join(UPLOADED_DIR, sourceFile), markdown, "utf8");

    return NextResponse.json({
      ok: true,
      contractKey,
      sourceFile: path.posix.join("_uploaded", sourceFile),
      bytes: filePart.size,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
