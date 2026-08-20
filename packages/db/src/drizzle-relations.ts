import { relations } from "drizzle-orm/relations";
import { users, sessions, workerBootstrapCredentials, organizations, runnerPools, workers, runnerLeases, jobClaims, commands, dashboardInstallations, dashboardRepositories, githubDiscoveryCheckpoints, dashboardRuns, dashboardJobs, dashboardOutboxInvalidations, organizationSettings, systemOnboarding, memberships, workerMutations, dashboardMutations, dashboardRunStages, dashboardLogChunks, dashboardStepLogChunks, dashboardJobSteps, dashboardJobResourceSamples, dashboardResourceObservations, dashboardJobTimingSnapshots } from "./drizzle-schema";

export const sessionsRelations = relations(sessions, ({one}) => ({
	user: one(users, {
		fields: [sessions.userId],
		references: [users.id]
	}),
}));

export const usersRelations = relations(users, ({many}) => ({
	sessions: many(sessions),
	workerBootstrapCredentials_createdBy: many(workerBootstrapCredentials, {
		relationName: "workerBootstrapCredentials_createdBy_users_id"
	}),
	workerBootstrapCredentials_rotatedBy: many(workerBootstrapCredentials, {
		relationName: "workerBootstrapCredentials_rotatedBy_users_id"
	}),
	systemOnboardings: many(systemOnboarding),
	memberships: many(memberships),
}));

export const workerBootstrapCredentialsRelations = relations(workerBootstrapCredentials, ({one}) => ({
	user_createdBy: one(users, {
		fields: [workerBootstrapCredentials.createdBy],
		references: [users.id],
		relationName: "workerBootstrapCredentials_createdBy_users_id"
	}),
	user_rotatedBy: one(users, {
		fields: [workerBootstrapCredentials.rotatedBy],
		references: [users.id],
		relationName: "workerBootstrapCredentials_rotatedBy_users_id"
	}),
}));

export const runnerPoolsRelations = relations(runnerPools, ({one, many}) => ({
	organization: one(organizations, {
		fields: [runnerPools.organizationId],
		references: [organizations.id]
	}),
	worker: one(workers, {
		fields: [runnerPools.workerId],
		references: [workers.id]
	}),
	runnerLeases: many(runnerLeases),
	systemOnboardings: many(systemOnboarding),
}));

export const organizationsRelations = relations(organizations, ({many}) => ({
	runnerPools: many(runnerPools),
	runnerLeases: many(runnerLeases),
	dashboardInstallations: many(dashboardInstallations),
	dashboardRepositories: many(dashboardRepositories),
	dashboardRuns: many(dashboardRuns),
	dashboardJobs: many(dashboardJobs),
	dashboardOutboxInvalidations: many(dashboardOutboxInvalidations),
	organizationSettings: many(organizationSettings),
	systemOnboardings: many(systemOnboarding),
	memberships: many(memberships),
	dashboardMutations: many(dashboardMutations),
	dashboardRunStages: many(dashboardRunStages),
	dashboardLogChunks: many(dashboardLogChunks),
	dashboardStepLogChunks: many(dashboardStepLogChunks),
	dashboardJobResourceSamples: many(dashboardJobResourceSamples),
	dashboardJobSteps: many(dashboardJobSteps),
	dashboardResourceObservations: many(dashboardResourceObservations),
	dashboardJobTimingSnapshots: many(dashboardJobTimingSnapshots),
}));

export const workersRelations = relations(workers, ({many}) => ({
	runnerPools: many(runnerPools),
	runnerLeases: many(runnerLeases),
	commands: many(commands),
	systemOnboardings: many(systemOnboarding),
	workerMutations: many(workerMutations),
	dashboardResourceObservations: many(dashboardResourceObservations),
}));

export const runnerLeasesRelations = relations(runnerLeases, ({one, many}) => ({
	organization: one(organizations, {
		fields: [runnerLeases.organizationId],
		references: [organizations.id]
	}),
	runnerPool: one(runnerPools, {
		fields: [runnerLeases.poolId],
		references: [runnerPools.id]
	}),
	worker: one(workers, {
		fields: [runnerLeases.workerId],
		references: [workers.id]
	}),
	jobClaims: many(jobClaims),
	dashboardJobResourceSamples: many(dashboardJobResourceSamples),
}));

export const jobClaimsRelations = relations(jobClaims, ({one}) => ({
	runnerLease: one(runnerLeases, {
		fields: [jobClaims.leaseId],
		references: [runnerLeases.id]
	}),
}));

export const commandsRelations = relations(commands, ({one}) => ({
	worker: one(workers, {
		fields: [commands.workerId],
		references: [workers.id]
	}),
}));

export const dashboardInstallationsRelations = relations(dashboardInstallations, ({one, many}) => ({
	organization: one(organizations, {
		fields: [dashboardInstallations.organizationId],
		references: [organizations.id]
	}),
	dashboardRepositories: many(dashboardRepositories),
}));

export const dashboardRepositoriesRelations = relations(dashboardRepositories, ({one, many}) => ({
	organization: one(organizations, {
		fields: [dashboardRepositories.organizationId],
		references: [organizations.id]
	}),
	dashboardInstallation: one(dashboardInstallations, {
		fields: [dashboardRepositories.organizationId],
		references: [dashboardInstallations.id]
	}),
	githubDiscoveryCheckpoints: many(githubDiscoveryCheckpoints),
	dashboardRuns: many(dashboardRuns),
	systemOnboardings: many(systemOnboarding),
}));

export const githubDiscoveryCheckpointsRelations = relations(githubDiscoveryCheckpoints, ({one}) => ({
	dashboardRepository: one(dashboardRepositories, {
		fields: [githubDiscoveryCheckpoints.repositoryId],
		references: [dashboardRepositories.id]
	}),
}));

export const dashboardRunsRelations = relations(dashboardRuns, ({one, many}) => ({
	organization: one(organizations, {
		fields: [dashboardRuns.organizationId],
		references: [organizations.id]
	}),
	dashboardRepository: one(dashboardRepositories, {
		fields: [dashboardRuns.organizationId],
		references: [dashboardRepositories.id]
	}),
	dashboardJobs: many(dashboardJobs),
	dashboardRunStages: many(dashboardRunStages),
	dashboardJobTimingSnapshots: many(dashboardJobTimingSnapshots),
}));

export const dashboardJobsRelations = relations(dashboardJobs, ({one, many}) => ({
	organization: one(organizations, {
		fields: [dashboardJobs.organizationId],
		references: [organizations.id]
	}),
	dashboardRun: one(dashboardRuns, {
		fields: [dashboardJobs.organizationId],
		references: [dashboardRuns.id]
	}),
	dashboardJobResourceSamples: many(dashboardJobResourceSamples),
	dashboardJobSteps: many(dashboardJobSteps),
	dashboardJobTimingSnapshots: many(dashboardJobTimingSnapshots),
}));

export const dashboardOutboxInvalidationsRelations = relations(dashboardOutboxInvalidations, ({one}) => ({
	organization: one(organizations, {
		fields: [dashboardOutboxInvalidations.organizationId],
		references: [organizations.id]
	}),
}));

export const organizationSettingsRelations = relations(organizationSettings, ({one}) => ({
	organization: one(organizations, {
		fields: [organizationSettings.organizationId],
		references: [organizations.id]
	}),
}));

export const systemOnboardingRelations = relations(systemOnboarding, ({one}) => ({
	user: one(users, {
		fields: [systemOnboarding.adminUserId],
		references: [users.id]
	}),
	worker: one(workers, {
		fields: [systemOnboarding.workerId],
		references: [workers.id]
	}),
	organization: one(organizations, {
		fields: [systemOnboarding.organizationId],
		references: [organizations.id]
	}),
	dashboardRepository: one(dashboardRepositories, {
		fields: [systemOnboarding.verificationRepositoryId],
		references: [dashboardRepositories.id]
	}),
	runnerPool: one(runnerPools, {
		fields: [systemOnboarding.verificationPoolId],
		references: [runnerPools.id]
	}),
}));

export const membershipsRelations = relations(memberships, ({one}) => ({
	organization: one(organizations, {
		fields: [memberships.organizationId],
		references: [organizations.id]
	}),
	user: one(users, {
		fields: [memberships.userId],
		references: [users.id]
	}),
}));

export const workerMutationsRelations = relations(workerMutations, ({one}) => ({
	worker: one(workers, {
		fields: [workerMutations.workerId],
		references: [workers.id]
	}),
}));

export const dashboardMutationsRelations = relations(dashboardMutations, ({one}) => ({
	organization: one(organizations, {
		fields: [dashboardMutations.organizationId],
		references: [organizations.id]
	}),
}));

export const dashboardRunStagesRelations = relations(dashboardRunStages, ({one}) => ({
	organization: one(organizations, {
		fields: [dashboardRunStages.organizationId],
		references: [organizations.id]
	}),
	dashboardRun: one(dashboardRuns, {
		fields: [dashboardRunStages.organizationId],
		references: [dashboardRuns.id]
	}),
}));

export const dashboardLogChunksRelations = relations(dashboardLogChunks, ({one}) => ({
	organization: one(organizations, {
		fields: [dashboardLogChunks.organizationId],
		references: [organizations.id]
	}),
}));

export const dashboardStepLogChunksRelations = relations(dashboardStepLogChunks, ({one}) => ({
	organization: one(organizations, {
		fields: [dashboardStepLogChunks.organizationId],
		references: [organizations.id]
	}),
	dashboardJobStep: one(dashboardJobSteps, {
		fields: [dashboardStepLogChunks.organizationId],
		references: [dashboardJobSteps.organizationId]
	}),
}));

export const dashboardJobStepsRelations = relations(dashboardJobSteps, ({one, many}) => ({
	dashboardStepLogChunks: many(dashboardStepLogChunks),
	organization: one(organizations, {
		fields: [dashboardJobSteps.organizationId],
		references: [organizations.id]
	}),
	dashboardJob: one(dashboardJobs, {
		fields: [dashboardJobSteps.organizationId],
		references: [dashboardJobs.id]
	}),
}));

export const dashboardJobResourceSamplesRelations = relations(dashboardJobResourceSamples, ({one}) => ({
	organization: one(organizations, {
		fields: [dashboardJobResourceSamples.organizationId],
		references: [organizations.id]
	}),
	runnerLease: one(runnerLeases, {
		fields: [dashboardJobResourceSamples.leaseId],
		references: [runnerLeases.id]
	}),
	dashboardJob: one(dashboardJobs, {
		fields: [dashboardJobResourceSamples.organizationId],
		references: [dashboardJobs.id]
	}),
}));

export const dashboardResourceObservationsRelations = relations(dashboardResourceObservations, ({one}) => ({
	organization: one(organizations, {
		fields: [dashboardResourceObservations.organizationId],
		references: [organizations.id]
	}),
	worker: one(workers, {
		fields: [dashboardResourceObservations.workerId],
		references: [workers.id]
	}),
}));

export const dashboardJobTimingSnapshotsRelations = relations(dashboardJobTimingSnapshots, ({one}) => ({
	organization: one(organizations, {
		fields: [dashboardJobTimingSnapshots.organizationId],
		references: [organizations.id]
	}),
	dashboardJob: one(dashboardJobs, {
		fields: [dashboardJobTimingSnapshots.organizationId],
		references: [dashboardJobs.id]
	}),
	dashboardRun: one(dashboardRuns, {
		fields: [dashboardJobTimingSnapshots.organizationId],
		references: [dashboardRuns.id]
	}),
}));