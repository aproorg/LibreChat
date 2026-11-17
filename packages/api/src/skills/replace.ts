import { logger } from '@librechat/data-schemas';
import type {
  ISkill,
  ISkillFile,
  UpdateSkillInput,
  UpdateSkillResult,
  UpsertSkillFileInput,
} from '@librechat/data-schemas';
import type { Types } from 'mongoose';

type StoredSkill = ISkill & { _id: Types.ObjectId };
type StoredSkillFile = ISkillFile & { _id: Types.ObjectId };

/** Data methods the replace-in-place import needs on top of the create path. */
export interface ReplaceSkillDeps {
  getAuthorSkillByName: (params: {
    name: string;
    author: Types.ObjectId | string;
    tenantId?: string;
  }) => Promise<StoredSkill | null>;
  updateSkill: (params: {
    id: string;
    expectedVersion: number;
    update: UpdateSkillInput;
  }) => Promise<UpdateSkillResult>;
  listSkillFiles: (skillId: Types.ObjectId | string) => Promise<StoredSkillFile[]>;
  deleteSkillFile: (
    skillId: Types.ObjectId | string,
    relativePath: string,
  ) => Promise<{ deleted: boolean }>;
}

interface CommitDeps extends ReplaceSkillDeps {
  getSkillById: (id: string | Types.ObjectId) => Promise<StoredSkill | null>;
  upsertSkillFile: (row: UpsertSkillFileInput) => Promise<StoredSkillFile>;
}

/** A blob already written to storage whose SkillFile row is not written yet. */
export type StagedSkillFile = Omit<UpsertSkillFileInput, 'skillId' | 'author' | 'tenantId'>;

export type ReplaceOutcome =
  | { status: 'replaced'; skill: StoredSkill }
  | { status: 'conflict'; current: StoredSkill; consistent: boolean }
  | {
      status: 'failed';
      /** True only when the stored skill is exactly what it was before the call. */
      consistent: boolean;
      failedPaths: string[];
    };

/**
 * Write the database half of a replace-in-place import.
 *
 * Every staged blob already has a fresh storage key (`<uuid>__<name>`), so the
 * old blobs are never overwritten and nothing observable changed until the
 * first row is written. From then on the skill may hold a mix of old and new,
 * and every failure reports `consistent: false`.
 *
 * A no-op `updateSkill` first claims the version (one bump), so a concurrent
 * replace loses before writing any row. Each `upsertSkillFile` then bumps the
 * version by exactly one, so the final `expectedVersion` is the version read
 * plus one plus the number of upserts. A foreign writer in between is a conflict.
 */
export async function commitReplacement(params: {
  deps: CommitDeps;
  existing: StoredSkill;
  update: UpdateSkillInput;
  staged: StagedSkillFile[];
  authorId: Types.ObjectId;
  tenantId?: string;
  deleteBlobs: (files: StoredSkillFile[]) => Promise<void>;
}): Promise<ReplaceOutcome> {
  const { deps, existing, update, staged, authorId, tenantId, deleteBlobs } = params;
  const skillId = existing._id;
  const stagedPaths = new Set(staged.map((file) => file.relativePath));

  let oldFiles: StoredSkillFile[];
  try {
    oldFiles = await deps.listSkillFiles(skillId);
  } catch (error) {
    logger.error(`[replaceSkill] Pre-write read failed for ${skillId}:`, error);
    return { status: 'failed', consistent: true, failedPaths: [] };
  }

  /** Claim the version before any row write so only one concurrent replace proceeds. */
  let claim: UpdateSkillResult;
  try {
    claim = await deps.updateSkill({
      id: skillId.toString(),
      expectedVersion: existing.version,
      update: { description: existing.description },
    });
  } catch (error) {
    logger.error(`[replaceSkill] Version claim failed for ${skillId}:`, error);
    return { status: 'failed', consistent: true, failedPaths: [] };
  }
  if (claim.status === 'conflict') {
    return { status: 'conflict', current: claim.current, consistent: true };
  }
  if (claim.status === 'not_found') {
    return { status: 'failed', consistent: true, failedPaths: [] };
  }

  for (const file of staged) {
    try {
      await deps.upsertSkillFile({ ...file, skillId, author: authorId, tenantId });
    } catch (error) {
      logger.error(`[replaceSkill] Row write failed for ${file.relativePath}:`, error);
      return { status: 'failed', consistent: false, failedPaths: [file.relativePath] };
    }
  }

  let updated: UpdateSkillResult;
  try {
    updated = await deps.updateSkill({
      id: skillId.toString(),
      expectedVersion: existing.version + 1 + staged.length,
      update,
    });
  } catch (error) {
    logger.error(`[replaceSkill] Skill update failed for ${skillId}:`, error);
    return { status: 'failed', consistent: false, failedPaths: [] };
  }
  if (updated.status === 'conflict') {
    return { status: 'conflict', current: updated.current, consistent: false };
  }
  if (updated.status === 'not_found') {
    return { status: 'failed', consistent: false, failedPaths: [] };
  }

  const removed: StoredSkillFile[] = [];
  const failedPaths: string[] = [];
  for (const old of oldFiles.filter((file) => !stagedPaths.has(file.relativePath))) {
    try {
      const { deleted } = await deps.deleteSkillFile(skillId, old.relativePath);
      if (deleted) {
        removed.push(old);
      }
    } catch (error) {
      logger.error(`[replaceSkill] Prune failed for ${old.relativePath}:`, error);
      failedPaths.push(old.relativePath);
    }
  }
  if (failedPaths.length > 0) {
    return { status: 'failed', consistent: false, failedPaths };
  }

  /** Blobs of replaced rows are unreferenced now; a failed delete only leaves reclaimable storage. */
  await deleteBlobs([...oldFiles.filter((file) => stagedPaths.has(file.relativePath)), ...removed]);

  const refreshed = (await deps.getSkillById(skillId)) ?? updated.skill;
  return { status: 'replaced', skill: refreshed };
}
