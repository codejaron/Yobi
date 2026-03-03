import test from "node:test";
import assert from "node:assert/strict";
import { selectTopComments } from "../services/browse/material-utils.js";

test("selectTopComments: should keep top 5 useful comments", () => {
  const comments = [
    { text: "nice", likes: 9999 },
    { text: "tim终于把价格打下来了 之前68真的离谱", likes: 32000 },
    { text: "建议出个安卓版 ios独占太恶心了", likes: 12000 },
    { text: "tim终于把价格打下来了 之前68真的离谱", likes: 18000 },
    { text: "这个一键电影感确实牛 但我觉得防抖才是最大升级", likes: 18000 },
    { text: "所以这期是广告还是测评 我分不清了哈哈哈", likes: 15000 },
    { text: "说实话画质提升没感觉 但稳定器效果肉眼可见", likes: 9000 },
    { text: "前排", likes: 100000 },
    { text: "  ", likes: 500 }
  ];

  const selected = selectTopComments(comments, 5);

  assert.equal(selected.length, 5);
  assert.equal(selected[0]?.text, "tim终于把价格打下来了 之前68真的离谱");
  assert.equal(selected[0]?.likes, 32000);
  assert.equal(selected.some((item) => item.text === "nice"), false);
  assert.equal(selected.some((item) => item.text === "前排"), false);
});

test("selectTopComments: should dedupe by text and keep higher like count", () => {
  const selected = selectTopComments(
    [
      { text: "同一句评论", likes: 10 },
      { text: "同一句评论", likes: 120 },
      { text: "另一个评论内容", likes: 50 }
    ],
    5
  );

  assert.equal(selected.length, 2);
  const target = selected.find((item) => item.text === "同一句评论");
  assert.equal(target?.likes, 120);
});
