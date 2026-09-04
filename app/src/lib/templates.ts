import {
  DeleteTemplateResponseSchema,
  TemplateListResponseSchema,
  TemplateResponseSchema,
  type GenerateTemplateRequest,
  type Template,
} from "@aibleton/protocol";
import { request } from "./mate";

/** Saved templates, newest first. */
export async function listTemplates(): Promise<Template[]> {
  const { templates } = await request("/templates", TemplateListResponseSchema);
  return templates;
}

/** Generates a template server-side. The result is NOT saved — POST it back with `saveTemplate`. */
export async function generateTemplate(opts: GenerateTemplateRequest = {}): Promise<Template> {
  const { template } = await request("/templates/generate", TemplateResponseSchema, {
    method: "POST",
    body: JSON.stringify(opts),
  });
  return template;
}

/** Upserts a template and returns what the store kept. */
export async function saveTemplate(template: Template): Promise<Template> {
  const res = await request("/templates", TemplateResponseSchema, {
    method: "POST",
    body: JSON.stringify({ template }),
  });
  return res.template;
}

/** True when a template was there to delete. */
export async function deleteTemplate(id: string): Promise<boolean> {
  const { deleted } = await request(`/templates/${encodeURIComponent(id)}`, DeleteTemplateResponseSchema, {
    method: "DELETE",
  });
  return deleted;
}
