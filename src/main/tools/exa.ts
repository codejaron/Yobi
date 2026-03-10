import { z } from "zod";
import { ExaSearchService } from "@main/services/exa-search";
import type { ToolDefinition } from "@main/tools/types";

const exaParamsSchema = z.object({
  query: z.string().min(1)
});

type ExaParams = z.infer<typeof exaParamsSchema>;

export function createExaTools(input: {
  exaSearchService: ExaSearchService;
}): Array<ToolDefinition<ExaParams>> {
  const webSearchTool: ToolDefinition<ExaParams> = {
    name: "web_search",
    source: "builtin",
    description: "搜索网页、新闻和通用资料，返回标题、链接、摘要与正文片段。",
    parameters: exaParamsSchema,
    isEnabled: (config) => config.tools.exa.enabled,
    async execute({ query }) {
      const data = await input.exaSearchService.searchWeb(query);
      return {
        success: true,
        data
      };
    },
    async dispose() {
      await input.exaSearchService.dispose();
    }
  };

  const codeSearchTool: ToolDefinition<ExaParams> = {
    name: "code_search",
    source: "builtin",
    description: "搜索 GitHub、官方文档和开发者问答中的代码上下文，返回链接、片段与正文。",
    parameters: exaParamsSchema,
    isEnabled: (config) => config.tools.exa.enabled,
    async execute({ query }) {
      const data = await input.exaSearchService.searchCode(query);
      return {
        success: true,
        data
      };
    }
  };

  return [webSearchTool, codeSearchTool];
}
