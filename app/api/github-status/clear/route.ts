import { NextResponse } from "next/server";
import { GitHubApiError, graphql } from "@/lib/github/client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// input を空にすると現在のユーザーステータスがクリアされる
const CLEAR_USER_STATUS_MUTATION = /* GraphQL */ `
  mutation ClearUserStatus {
    changeUserStatus(input: {}) {
      status {
        indicatesLimitedAvailability
      }
    }
  }
`;

export async function POST(request: Request) {
  try {
    await graphql(CLEAR_USER_STATUS_MUTATION);
    console.log(
      `[github-status] cleared at ${new Date().toISOString()} ua=${request.headers.get("user-agent") ?? "-"} referer=${request.headers.get("referer") ?? "-"}`,
    );
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message =
      error instanceof GitHubApiError ? error.message : String(error);
    console.error("[github-status] clear failed:", message);
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
