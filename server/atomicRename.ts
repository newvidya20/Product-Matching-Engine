import fsp from 'node:fs/promises';

const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * Renames tmp over file. On Windows, OneDrive / antivirus / indexers briefly lock the target and rename
 * fails with EPERM. Retry with a short backoff; as a last resort copy over the target and remove the temp.
 */
export async function renameReplace(tmp: string, file: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await fsp.rename(tmp, file);
      return;
    } catch (error) {
      lastError = error;
      if (!BUSY.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
    }
  }
  try {
    await fsp.copyFile(tmp, file);
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
  } catch {
    throw lastError;
  }
}
