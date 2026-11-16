/**
 * Where each API path lives in the command tree. Groups follow the creator UI's sections,
 * not the API's path layout. Paths here have `/v1` and any `/creators/{creatorUserUuid}`
 * prefix already removed.
 */
export const SECTIONS: [prefix: string, command: string[]][] = [
  ["/chats/lists/custom", ["fans", "lists", "custom"]],
  ["/chats/lists/dynamic", ["fans", "lists", "dynamic"]],
  ["/chats/lists/smart", ["fans", "lists", "smart"]],
  ["/chats/templates/folders", ["messages", "templates", "folders"]],
  ["/chats/templates", ["messages", "templates"]],
  ["/chats/automated-messages", ["messages", "automated"]],
  ["/chats/mass-messages", ["messages", "mass"]],
  ["/chats", ["messages"]],
  ["/insights/fans", ["fans", "insights"]],
  ["/insights", ["insights"]],
  ["/subscribers", ["fans", "subscribers"]],
  ["/followers", ["fans", "followers"]],
  ["/blocks", ["fans", "blocks"]],
  ["/media/uploads", ["vault", "uploads"]],
  ["/media/links", ["links", "media"]],
  ["/media-links", ["links", "media"]],
  ["/media", ["vault", "media"]],
  ["/vault/folders", ["vault", "folders"]],
  ["/collections", ["vault", "collections"]],
  ["/posts", ["posts"]],
  ["/tracking-links", ["links", "tracking"]],
  ["/checkout-links", ["links", "checkout"]],
  ["/free-trial-links", ["links", "free-trial"]],
  ["/promotions", ["promotions"]],
  ["/users/me/subscription-price", ["account", "subscription-price"]],
  ["/users/me", ["account"]],
  ["/users/account", ["account", "details"]],
  ["/account-health", ["account", "health"]],
  ["/notifications", ["account", "notifications"]],
  ["/onboarding/creators", ["agency", "onboard-creator"]],
  ["/agencies", ["agency"]],
  ["/creators", ["agency", "creators"]],
  ["/webhooks/subscriptions", ["webhooks"]],
  ["/webhooks", ["webhooks"]],
  ["/apps", ["apps"]],
];

/**
 * Routes the CLI never exposes. Experiences and the `/me` app routes act for an app or a fan,
 * and the CLI's token is a creator's grant to the CLI itself.
 */
export const EXCLUDED_PREFIXES = [
  "/experiences",
  "/apps/{appUuid}/subscription",
  "/apps/{appUuid}/payments/me",
  "/apps/{appUuid}/experience-action-definitions",
];

/**
 * Creator-scoped routes whose self-scoped twin lives at a different path. Mapping them lets
 * the two fold into one command with `--creator`.
 */
export const CREATOR_ALIASES: Record<string, string> = {
  "/account": "/users/account",
  "/subscription-price": "/users/me/subscription-price",
};

/** Names the rules get wrong, keyed by `METHOD path` (normalised, without `/v1`). */
export const OVERRIDES: Record<string, string[]> = {
  "GET /users/me": ["account", "me"],
  "POST /onboarding/creators": ["agency", "onboard-creator"],
  "POST /chats": ["messages", "start"],
  "POST /chats/{userUuid}/message": ["messages", "send"],
  "GET /chats/{userUuid}/messages": ["messages", "read"],
  "GET /chats/{userUuid}/messages/{messageUuid}": ["messages", "get"],
  "DELETE /chats/{userUuid}/messages/{messageUuid}": ["messages", "delete"],
  "GET /chats/{userUuid}/messages/{messageUuid}/media": ["messages", "media"],
  "GET /chats/{userUuid}/media": ["messages", "shared-media"],
  "GET /chats/{userUuid}": ["messages", "chat"],
  "PATCH /chats/{userUuid}": ["messages", "update-chat"],
  "GET /chats/{userUuid}/notes": ["fans", "notes", "get"],
  "PUT /chats/{userUuid}/notes": ["fans", "notes", "set"],
  "POST /chats/messages/batch": ["messages", "batch"],
  "POST /chats/statuses": ["messages", "statuses"],
  "POST /chats/mass-messages": ["messages", "mass", "send"],
  "POST /blocks/{userUuid}": ["fans", "blocks", "add"],
  "DELETE /blocks/{userUuid}": ["fans", "blocks", "remove"],
  "POST /chats/lists/custom/{uuid}/members": ["fans", "lists", "custom", "add-members"],
  "DELETE /chats/lists/custom/{uuid}/members/{userUuid}": [
    "fans",
    "lists",
    "custom",
    "remove-member",
  ],
  "GET /chats/lists/custom/{uuid}": ["fans", "lists", "custom", "members"],
  "GET /chats/lists/smart/{uuid}": ["fans", "lists", "smart", "members"],
  "POST /chats/lists/dynamic/preview/count": ["fans", "lists", "dynamic", "preview-count"],
  "POST /chats/lists/dynamic/preview/members": ["fans", "lists", "dynamic", "preview-members"],
  "PUT /chats/automated-messages/{trigger}": ["messages", "automated", "set"],
  "POST /chats/templates": ["messages", "templates", "save"],
  "POST /media/uploads": ["vault", "uploads", "start"],
  "PATCH /media/uploads/{uploadId}": ["vault", "uploads", "complete"],
  "GET /media/uploads/{uploadId}/parts/urls": ["vault", "uploads", "part-urls"],
  "GET /media/uploads/{uploadId}/parts/{partNumber}/url": ["vault", "uploads", "part-url"],
  "GET /media/{uuid}/entitled": ["vault", "media", "entitled"],
  "GET /media/links/{uuid}/purchased": ["links", "media", "purchased"],
  "POST /vault/folders/{folderName}/media": ["vault", "folders", "add-media"],
  "GET /vault/folders/{folderName}/media": ["vault", "folders", "media"],
  "PATCH /vault/folders/{folderName}/media/{mediaUuid}": ["vault", "folders", "update-media"],
  "DELETE /vault/folders/{folderName}/media/{mediaUuid}": ["vault", "folders", "remove-media"],
  "PATCH /users/me/subscription-price": ["account", "subscription-price", "set"],
  "PUT /agencies/team-members/{userId}": ["agency", "team-members", "update"],
  "POST /agencies/invites": ["agency", "invite-member"],
  "POST /agencies/creator-invites": ["agency", "invite-creator"],
  "POST /agencies/posts": ["agency", "posts", "create"],
  "POST /agencies/chats/messages/batch": ["agency", "chats", "batch"],
  "POST /webhooks/test": ["webhooks", "test"],
  "GET /checkout-links/payments/{invoiceNumber}": ["links", "checkout", "payment"],
  "POST /checkout-links/payments/{invoiceNumber}/refund-requests": [
    "links",
    "checkout",
    "request-refund",
  ],
  "POST /checkout-links/refund-requests/{uuid}/withdraw": ["links", "checkout", "withdraw-refund"],
  "POST /checkout-links/subscriptions/{uuid}/cancel": ["links", "checkout", "cancel-subscription"],
  "POST /checkout-links/subscriptions/{uuid}/uncancel": [
    "links",
    "checkout",
    "uncancel-subscription",
  ],
  "GET /tracking-links/{uuid}/users/{userUuid}/metadata": ["links", "tracking", "user-metadata"],
};

/**
 * Writes fans see or pay for. These need the creator handle typed back, not just a yes.
 * Keyed like OVERRIDES.
 */
export const FAN_FACING = new Set([
  "POST /chats/mass-messages",
  "PATCH /chats/mass-messages/{messageUuid}",
  "PATCH /users/me/subscription-price",
  "POST /media/{uuid}/grant",
  "POST /promotions",
  "PUT /promotions/{promotionUuid}",
  "DELETE /promotions/{promotionUuid}",
  "POST /checkout-links",
  "PATCH /checkout-links/{uuid}",
  "DELETE /checkout-links/{uuid}",
  "POST /checkout-links/subscriptions/{uuid}/cancel",
  "POST /checkout-links/subscriptions/{uuid}/uncancel",
  "POST /checkout-links/payments/{invoiceNumber}/refund-requests",
  "POST /free-trial-links",
  "PUT /free-trial-links/{uuid}",
]);

/** POST routes that only read: bulk lookups with a JSON body. They need no confirmation. */
export const READ_ONLY_POSTS = new Set([
  "POST /chats/messages/batch",
  "POST /agencies/chats/messages/batch",
  "POST /chats/statuses",
  "POST /insights/fans/batch",
  "POST /insights/fans/profiles",
  "POST /chats/lists/dynamic/translate",
  "POST /chats/lists/dynamic/preview/count",
  "POST /chats/lists/dynamic/preview/members",
]);
