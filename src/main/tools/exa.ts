import { z } from "zod";
import { ExaSearchService } from "@main/services/exa-search";
import type { ToolDefinition } from "@main/tools/types";

const exaParamsSchema = z.object({
  query: z.string().min(1).describe("要搜索的查询词。")
});

const fetchParamsSchema = z.object({
  url: z.string().url().describe("要抓取正文内容的网页 URL。")
});

type ExaParams = z.infer<typeof exaParamsSchema>;
type FetchParams = z.infer<typeof fetchParamsSchema>;

export function createExaTools(input: {
  exaSearchService: ExaSearchService;
}): Array<ToolDefinition<any>> {
  const webSearchTool: ToolDefinition<ExaParams> = {
    name: "web_search",
    source: "builtin",
    description: "搜索网页、新闻和通用资料，返回标题、链接、摘要与正文片段。适合信息检索。",
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
    description: "搜索 GitHub、官方文档和开发者问答中的代码上下文，返回链接、片段与正文。适合技术与代码问题。",
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

  const webFetchTool: ToolDefinition<FetchParams> = {
    name: "web_fetch",
    source: "builtin",
    description: "抓取指定网页 URL 的正文内容和摘要。适合拿到页面全文后再总结。",
    parameters: fetchParamsSchema,
    isEnabled: (config) => config.tools.exa.enabled,
    async execute({ url }) {
      const data = await input.exaSearchService.fetchWeb(url);
      return {
        success: true,
        data
      };
    }
  };

  return [webSearchTool, codeSearchTool, webFetchTool];
}
