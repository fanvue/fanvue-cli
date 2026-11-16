import type { CommandSpec } from "./types.ts";

export const UPLOAD_OPERATION = "cli:uploadMedia";

/** Commands that combine several API calls. Each one still only calls documented routes. */
export const handwrittenCommands: CommandSpec[] = [
  {
    operationId: UPLOAD_OPERATION,
    command: ["vault", "media", "upload"],
    args: ["file"],
    method: "POST",
    path: "/v1/media/uploads",
    creatorPath: "/v1/creators/{creatorUserUuid}/media/uploads",
    query: [],
    body: {
      required: false,
      fields: [
        { name: "name", required: false, type: "string", description: "Defaults to the file name" },
        {
          name: "mediaType",
          required: false,
          type: "string",
          description: "image, video, audio or document; worked out from the extension otherwise",
        },
      ],
    },
    scopes: ["write:media"],
    gate: "write",
    summary: "Upload a file to your media and wait until it is ready to attach",
  },
];
