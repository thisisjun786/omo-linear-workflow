import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";
import { z } from "zod";

export interface RouteRung {
  readonly providers: readonly string[];
  readonly model: string;
  readonly variant?: string;
}

export interface UpstreamPolicy {
  readonly version: string;
  readonly digest: string;
  readonly categories: Readonly<Record<string, readonly RouteRung[]>>;
  readonly agents: Readonly<
    Record<
      string,
      {
        readonly models?: readonly RouteRung[];
        readonly categories?: readonly string[];
      }
    >
  >;
}

const nonemptyString = z.string().min(1);
const sourceInputSchema = z.object({
  source: nonemptyString,
  version: nonemptyString,
});
const packageRootSchema = nonemptyString;
const packageManifestSchema = z.object({ version: nonemptyString });
const routeRungSchema = z.strictObject({
  providers: z.array(nonemptyString).min(1),
  model: nonemptyString,
  variant: nonemptyString.optional(),
});
const categoryAnchors = ["visual-engineering", "deep-low", "quick"];
const agentAnchors = ["explore", "librarian", "plan-consultant", "plan-reviewer"];

class RoutingSourceError extends Error {
  constructor(message: string) {
    super(`Cannot extract OMO upstream routing policy: ${message}`);
    this.name = "RoutingSourceError";
  }
}

function staticPropertyName(property: ts.ObjectLiteralElementLike): string | undefined {
  if (!ts.isPropertyAssignment(property)) return undefined;
  if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) {
    return property.name.text;
  }
  return undefined;
}

function propertyMap(
  object: ts.ObjectLiteralExpression,
  context: string,
): Map<string, ts.Expression> {
  const properties = new Map<string, ts.Expression>();
  for (const property of object.properties) {
    const name = staticPropertyName(property);
    if (name === undefined || !ts.isPropertyAssignment(property)) {
      throw new RoutingSourceError(`${context} must contain only literal property assignments`);
    }
    if (properties.has(name)) {
      throw new RoutingSourceError(
        `${context} contains duplicate property ${JSON.stringify(name)}`,
      );
    }
    properties.set(name, property.initializer);
  }
  return properties;
}

function literalString(expression: ts.Expression, context: string): string {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    const parsed = nonemptyString.safeParse(expression.text);
    if (parsed.success) return parsed.data;
  }
  throw new RoutingSourceError(`${context} must be a non-empty string literal`);
}

function literalStringArray(expression: ts.Expression, context: string): readonly string[] {
  if (!ts.isArrayLiteralExpression(expression)) {
    throw new RoutingSourceError(`${context} must be a literal string array`);
  }
  return expression.elements.map((element, index) => {
    if (ts.isSpreadElement(element)) {
      throw new RoutingSourceError(`${context}[${index}] cannot be a spread expression`);
    }
    return literalString(element, `${context}[${index}]`);
  });
}

function routeRung(expression: ts.Expression, context: string): RouteRung {
  if (!ts.isObjectLiteralExpression(expression)) {
    throw new RoutingSourceError(`${context} must be a literal route object`);
  }
  const properties = propertyMap(expression, context);
  for (const name of properties.keys()) {
    if (name !== "providers" && name !== "model" && name !== "variant") {
      throw new RoutingSourceError(
        `${context} has unsupported route property ${JSON.stringify(name)}`,
      );
    }
  }
  const providers = properties.get("providers");
  const model = properties.get("model");
  const variant = properties.get("variant");
  if (!providers || !model) {
    throw new RoutingSourceError(`${context} requires literal providers and model properties`);
  }
  const literalProviders = literalStringArray(providers, `${context}.providers`);
  const literalModel = literalString(model, `${context}.model`);
  if (!variant) {
    const value = { providers: literalProviders, model: literalModel };
    const parsed = routeRungSchema.safeParse(value);
    if (!parsed.success) {
      throw new RoutingSourceError(`${context} is invalid: ${z.prettifyError(parsed.error)}`);
    }
    return value;
  }
  const value = {
    providers: literalProviders,
    model: literalModel,
    variant: literalString(variant, `${context}.variant`),
  };
  const parsed = routeRungSchema.safeParse(value);
  if (!parsed.success) {
    throw new RoutingSourceError(`${context} is invalid: ${z.prettifyError(parsed.error)}`);
  }
  return value;
}

function routeList(expression: ts.Expression, context: string): readonly RouteRung[] {
  if (!ts.isArrayLiteralExpression(expression)) {
    throw new RoutingSourceError(`${context} must be a literal route array`);
  }
  if (expression.elements.length === 0) {
    throw new RoutingSourceError(`${context} must contain at least one literal route`);
  }
  return expression.elements.map((element, index) => {
    if (ts.isSpreadElement(element)) {
      throw new RoutingSourceError(`${context}[${index}] cannot be a spread expression`);
    }
    return routeRung(element, `${context}[${index}]`);
  });
}

function hasProperties(object: ts.ObjectLiteralExpression, required: readonly string[]): boolean {
  const names = new Set(object.properties.map(staticPropertyName));
  return required.every((name) => names.has(name));
}

function singleTable(
  candidates: readonly ts.ObjectLiteralExpression[],
  kind: "category" | "agent",
): ts.ObjectLiteralExpression {
  if (candidates.length === 0) {
    throw new RoutingSourceError(
      `${kind} routing table is missing; expected structural keys ${
        kind === "category" ? categoryAnchors.join(", ") : agentAnchors.join(", ")
      }`,
    );
  }
  if (candidates.length > 1) {
    throw new RoutingSourceError(
      `${kind} routing table is ambiguous; found ${candidates.length} structural matches`,
    );
  }
  const candidate = candidates[0];
  if (!candidate) throw new RoutingSourceError(`${kind} routing table could not be selected`);
  return candidate;
}

function parseCategoryTable(
  object: ts.ObjectLiteralExpression,
): Readonly<Record<string, readonly RouteRung[]>> {
  const entries: Array<readonly [string, readonly RouteRung[]]> = [];
  for (const [name, expression] of propertyMap(object, "category routing table")) {
    entries.push([name, routeList(expression, `category ${JSON.stringify(name)}`)]);
  }
  return Object.fromEntries(entries);
}

function parseAgentTable(
  object: ts.ObjectLiteralExpression,
): Array<readonly [string, { readonly models: readonly RouteRung[] }]> {
  const entries: Array<readonly [string, { readonly models: readonly RouteRung[] }]> = [];
  for (const [name, expression] of propertyMap(object, "named-agent routing table")) {
    entries.push([name, { models: routeList(expression, `agent ${JSON.stringify(name)} models`) }]);
  }
  return entries;
}

function nativeAgentName(object: ts.ObjectLiteralExpression): string | undefined {
  for (const property of object.properties) {
    if (staticPropertyName(property) !== "name" || !ts.isPropertyAssignment(property)) continue;
    const initializer = property.initializer;
    if (
      (ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer)) &&
      initializer.text.startsWith("omo-native-")
    ) {
      return initializer.text;
    }
  }
  return undefined;
}

function parseNativeAgent(
  object: ts.ObjectLiteralExpression,
  expectedName: string,
): readonly [string, { readonly categories: readonly string[] }] {
  const context = `native agent ${JSON.stringify(expectedName)}`;
  const properties = propertyMap(object, context);
  const name = properties.get("name");
  const mode = properties.get("mode");
  const categories = properties.get("categories");
  if (!name || literalString(name, `${context}.name`) !== expectedName) {
    throw new RoutingSourceError(`${context} has an unsupported name shape`);
  }
  if (!mode || literalString(mode, `${context}.mode`) !== "subagent") {
    throw new RoutingSourceError(`${context} must have literal mode "subagent"`);
  }
  if (!categories) {
    throw new RoutingSourceError(`${context} must inherit a literal categories array`);
  }
  if (properties.has("model") || properties.has("models")) {
    throw new RoutingSourceError(`${context} has an unsupported explicit model routing shape`);
  }
  const inheritedCategories = literalStringArray(categories, `${context}.categories`);
  if (inheritedCategories.length === 0) {
    throw new RoutingSourceError(`${context}.categories must not be empty`);
  }
  return [expectedName, { categories: inheritedCategories }];
}

export function extractRoutingPolicy(source: string, version: string): UpstreamPolicy {
  const input = sourceInputSchema.parse({ source, version });
  const sourceFile = ts.createSourceFile(
    "omo-task.js",
    input.source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const categoryCandidates: ts.ObjectLiteralExpression[] = [];
  const agentCandidates: ts.ObjectLiteralExpression[] = [];
  const nativeCandidates: Array<readonly [string, ts.ObjectLiteralExpression]> = [];

  function visit(node: ts.Node): void {
    if (ts.isObjectLiteralExpression(node)) {
      if (hasProperties(node, categoryAnchors)) categoryCandidates.push(node);
      if (hasProperties(node, agentAnchors)) agentCandidates.push(node);
      const name = nativeAgentName(node);
      if (name !== undefined) nativeCandidates.push([name, node]);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  const categories = parseCategoryTable(singleTable(categoryCandidates, "category"));
  const agentEntries: Array<
    readonly [
      string,
      { readonly models?: readonly RouteRung[]; readonly categories?: readonly string[] },
    ]
  > = [...parseAgentTable(singleTable(agentCandidates, "agent"))];
  const names = new Set(agentEntries.map(([name]) => name));
  for (const [name, object] of nativeCandidates) {
    if (names.has(name)) {
      throw new RoutingSourceError(`agent routing for ${JSON.stringify(name)} is ambiguous`);
    }
    agentEntries.push(parseNativeAgent(object, name));
    names.add(name);
  }

  return {
    version: input.version,
    digest: createHash("sha256").update(input.source).digest("hex"),
    categories,
    agents: Object.fromEntries(agentEntries),
  };
}

export async function readRoutingPolicy(packageRoot: string): Promise<UpstreamPolicy> {
  const root = packageRootSchema.parse(packageRoot);
  const bundlePath = join(root, "plugin/extensions/omo-task.js");
  const manifestPath = join(root, "package.json");
  let bundle: Uint8Array;
  let manifestSource: string;
  try {
    [bundle, manifestSource] = await Promise.all([
      readFile(bundlePath),
      readFile(manifestPath, "utf8"),
    ]);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new RoutingSourceError(
      `cannot read ${bundlePath} and ${manifestPath}; verify the installed OMO package root (${detail})`,
    );
  }

  let manifest: z.output<typeof packageManifestSchema>;
  try {
    manifest = packageManifestSchema.parse(JSON.parse(manifestSource));
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new RoutingSourceError(`invalid OMO package manifest at ${manifestPath} (${detail})`);
  }

  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bundle);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new RoutingSourceError(`OMO task bundle is not valid UTF-8 at ${bundlePath} (${detail})`);
  }
  const policy = extractRoutingPolicy(source, manifest.version);
  const digest = createHash("sha256").update(bundle).digest("hex");
  return { ...policy, digest };
}
