import type { components, operations } from "./schema.js";

type Schemas = components["schemas"];

export type Balance = Schemas["Balance"];
export type Candidate = Schemas["Candidate"];
export type DiscoverRequest = Schemas["DiscoverRequest"];
export type DiscoverResponse = Schemas["DiscoverResponse"];
export type InspectRequest = Schemas["InspectRequest"];
export type Price = Schemas["Price"];
export type Run = Schemas["Run"];
export type RunPage = Schemas["RunPage"];
export type RunRequest = Schemas["RunRequest"];
export type RunResult = Schemas["RunResult"];
export type RunStatus = Schemas["RunStatus"];
export type Tool = Schemas["Tool"];
export type ToolInspection = Schemas["ToolInspection"];
export type ToolPage = Schemas["ToolPage"];
export type ProviderCatalog = Schemas["ProviderCatalog"];
export type PublicCatalog = Schemas["PublicCatalog"];
export type PublicEndpointPage = Schemas["PublicEndpointPage"];
export type PublicRankings = Schemas["PublicRankings"];

export type ListRunsParams = NonNullable<operations["listRuns"]["parameters"]["query"]>;
export type ListToolsParams = NonNullable<operations["listTools"]["parameters"]["query"]>;
export type PublicEndpointsParams = NonNullable<
  operations["getPublicEndpoints"]["parameters"]["query"]
>;
