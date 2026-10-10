import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, schema } from '@mars/db';
import { eq } from 'drizzle-orm';
import { initializeControlPlaneSetup } from './control-plane-setup.ts';

const integration = Bun.env.MARS_E2E_DATABASE_URL ? test : test.skip;

integration.each([0, 2])('returning administrator keeps %i authorized memberships and removes stale access', async count => {
  const db = createDb(Bun.env.MARS_E2E_DATABASE_URL!);
  const root = await mkdtemp(join(tmpdir(), 'mars-auth-regression-'));
  try {
    await db.transaction(async tx => {
      for (const table of ['users', 'organizations', 'memberships', 'dashboard_installations', 'control_plane_config', 'system_onboarding']) {
        await tx.$client.unsafe(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING DEFAULTS INCLUDING INDEXES INCLUDING CONSTRAINTS) ON COMMIT DROP`);
      }
      const [user] = await tx.insert(schema.users).values({ githubUserId: 42, login: 'administrator', isGlobalAdmin: true }).returning();
      await tx.insert(schema.controlPlaneConfig).values({ singleton: true, publicBaseUrl: 'https://control.test', setupCompletedAt: '2026-10-01T00:00:00Z' });
      const authorized: string[] = [];
      for (let i = 0; i <= count; i++) {
        const [organization] = await tx.insert(schema.organizations).values({ githubOrgId: 100 + i, login: `org-${i}` }).returning();
        await tx.insert(schema.memberships).values({ organizationId: organization!.id, userId: user!.id, role: 'member' });
        if (i < count) {
          authorized.push(organization!.id);
          await tx.insert(schema.dashboardInstallations).values({ organizationId: organization!.id, githubInstallationId: 1000 + i, state: 'approved' });
        }
      }
      const { setup } = await initializeControlPlaneSetup(tx, root);
      expect(await setup.authenticate({ id: 42, login: 'renamed-admin', accessToken: 'unused-for-known-admin' })).toEqual({ userId: user!.id, firstAdmin: false });
      const memberships = await tx.select().from(schema.memberships).where(eq(schema.memberships.userId, user!.id));
      expect(memberships.map(row => row.organizationId).sort()).toEqual(authorized.sort());
      const [saved] = await tx.select().from(schema.users).where(eq(schema.users.id, user!.id));
      expect(saved).toMatchObject({ login: 'renamed-admin', isGlobalAdmin: true });
    });
  } finally {
    await db.$client.end();
    await rm(root, { recursive: true, force: true });
  }
});
