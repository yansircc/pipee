export const prerender = true;

export const GET = () =>
  new Response(
    JSON.stringify({
      sha: process.env.GITHUB_SHA ?? "development",
    }),
    {
      headers: {
        "content-type": "application/json; charset=utf-8",
      },
    },
  );
