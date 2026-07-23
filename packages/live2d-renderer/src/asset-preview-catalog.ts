export interface Live2dExpressionPreviewResource {
  id: string;
  file: string;
}

export interface Live2dMotionPreviewResource {
  id: string;
  group: string;
  index: number;
  file: string;
}

export interface Live2dAssetPreviewCatalog {
  expressions: Live2dExpressionPreviewResource[];
  motions: Live2dMotionPreviewResource[];
}

/** Extracts renderer resource identities without assigning unverified semantics. */
export function createLive2dAssetPreviewCatalog(settings: unknown): Live2dAssetPreviewCatalog {
  const root = record(settings, 'Live2D model settings');
  const references = record(root.FileReferences, 'Live2D FileReferences');
  const expressions = optionalArray(references.Expressions, 'Live2D Expressions').map((value, index) => {
    const expression = record(value, `Live2D Expressions[${index}]`);
    return {
      id: text(expression.Name, `Live2D Expressions[${index}].Name`),
      file: text(expression.File, `Live2D Expressions[${index}].File`),
    };
  });
  const motionGroups = references.Motions === undefined
    ? {}
    : record(references.Motions, 'Live2D Motions');
  const motions = Object.entries(motionGroups).flatMap(([group, values]) =>
    optionalArray(values, `Live2D Motions.${group}`).map((value, index) => {
      const motion = record(value, `Live2D Motions.${group}[${index}]`);
      return {
        id: `${group}:${index}`,
        group,
        index,
        file: text(motion.File, `Live2D Motions.${group}[${index}].File`),
      };
    }));
  return { expressions, motions };
}

function optionalArray(value: unknown, label: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be non-empty`);
  return value.trim();
}
