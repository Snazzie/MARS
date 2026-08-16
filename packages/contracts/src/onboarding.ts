import { z } from "zod";
import { RuntimePlatform, GuestPlatform, WorkerState, ConnectionState, ConfigurationState, WorkerDoctorData, WorkerCapacityData, WorkerLimits } from "./orchestration.ts";
import { OrganizationSummary, RepositorySummary, PoolSummary } from "./dashboard.ts";

export const OnboardingStep = z.enum(["admin", "worker", "github", "labels", "complete"]);
export type OnboardingStep = z.infer<typeof OnboardingStep>;
export const OnboardingStatus = z.object({ version:z.literal(1), onboardingRequired:z.boolean(), adminCreated:z.boolean(), authenticated:z.boolean(), canManage:z.boolean(), step:OnboardingStep }).strict();
export type OnboardingStatus = z.infer<typeof OnboardingStatus>;
export const OnboardingWorker = z.object({ id:z.string().uuid(), name:z.string().min(1), platform:RuntimePlatform, guestPlatforms:z.array(GuestPlatform).min(1).optional(), admissionState:WorkerState, connectionState:ConnectionState, configurationState:ConfigurationState, publicKey:z.string(), fingerprint:z.string(), vmUuid:z.string(), machineUuid:z.string(), doctor:WorkerDoctorData, capacity:WorkerCapacityData, limits:WorkerLimits.nullable(), configurationRevision:z.string().nullable() }).strict();
export type OnboardingWorker = z.infer<typeof OnboardingWorker>;
export const OnboardingInstallation = z.object({ id:z.string().uuid(), githubInstallationId:z.number().int(), state:z.enum(["pending","approved","suspended"]), repositorySelection:z.enum(["all","selected"]).nullable() }).strict();
export type OnboardingInstallation = z.infer<typeof OnboardingInstallation>;
export const OnboardingDetail = OnboardingStatus.extend({ worker:OnboardingWorker.nullable(), organizations:z.array(OrganizationSummary), github:z.object({ appConfigured:z.boolean(), organizationId:z.string().uuid().nullable(), installation:OnboardingInstallation.nullable(), repositories:z.array(RepositorySummary) }).strict(), pool:PoolSummary.nullable(), defaultImageDigests:z.record(GuestPlatform,z.string().nullable()).default({}), defaultImageDigest:z.string().nullable().optional() }).strict();
export type OnboardingDetail = z.infer<typeof OnboardingDetail>;
export const SelectOnboardingWorkerRequest = z.object({ workerId:z.string().uuid() }).strict();
export type SelectOnboardingWorkerRequest = z.infer<typeof SelectOnboardingWorkerRequest>;
export const VerifyOnboardingRepositoriesResult = z.object({ ok:z.literal(true), organizationId:z.string().uuid(), repositoryCount:z.number().int().min(1) }).strict();
export type VerifyOnboardingRepositoriesResult = z.infer<typeof VerifyOnboardingRepositoriesResult>;
