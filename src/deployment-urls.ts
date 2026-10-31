import type { Env } from './types.ts';
import { deploymentPaths } from './util.ts';

/** Addresses follow this deployment's mount and request origin, never a grant's old audience. */
export function deploymentUrls(url: string, env: Pick<Env, 'MOUNT'>) {
  const origin = new URL(url).origin;
  const paths = deploymentPaths(env.MOUNT);
  return Object.fromEntries(Object.entries(paths).map(([name, path]) => [name, origin + path])) as { [K in keyof typeof paths]: string };
}
