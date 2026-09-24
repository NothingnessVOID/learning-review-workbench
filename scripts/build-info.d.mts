export interface BuildInfo { fingerprint: string; lock_hash: string; version: string; commit: string; built_at: string }
export const root: string;
export function fingerprints(project?: string): Pick<BuildInfo, 'fingerprint' | 'lock_hash'>;
export function readBuild(project?: string): BuildInfo | null;
export function isCurrentBuild(info: BuildInfo | null, current: Pick<BuildInfo, 'fingerprint' | 'lock_hash'>): boolean;
export function writeBuild(project?: string): BuildInfo;
