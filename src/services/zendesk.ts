import { zendeskEndpoints, zendeskApi } from "../utils/zendeskClient";
import config, { SERVER_ENVIRONMENT } from "../config";
const isDev = config.ENVIRONMENT === SERVER_ENVIRONMENT.DEVELOPMENT;
const zendeskSupport = 16685599304861;
const onboardingEmailField = 24479112842269;
const environmentField = 24752059256477;
const isTipField = 32435958308509;

const ZENDESK_DISABLED_MESSAGE = "Zendesk integration is temporarily disabled";

export const isZendeskEnabled = () => config.ZENDESK_ENABLED;

export const getZendeskDisabledResponse = (data = {}) => ({
  status: 503,
  code: "ZENDESK_DISABLED",
  message: ZENDESK_DISABLED_MESSAGE,
  ...data,
});

const assertZendeskEnabled = () => {
  if (!isZendeskEnabled()) {
    throw new Error("ZENDESK_DISABLED");
  }
};

export const uploadImagesToZendesk = async (data) => {
  assertZendeskEnabled();
  const uploadPromises = data.map(async (file) => {
    const headers = {
      "Content-Type": file.mimetype || "application/octet-stream",
    };
    const zendeskRes = await zendeskApi.post(
      `${zendeskEndpoints.uploadFile}?filename=${encodeURIComponent(
        file.originalname
      )}`,
      file.buffer,
      { headers }
    );
    return zendeskRes.data.upload.token;
  });
  const tokens = await Promise.all(uploadPromises);
  return tokens;
};

export const getZendeskTickets = async (conciergeUserId) => {
  assertZendeskEnabled();
  const res = await zendeskApi.get(zendeskEndpoints.getTickets, {
    params: {
      external_id: conciergeUserId,
      include: "comment_count",
      sort_by: "created_at",
      sort_order: "desc",
    },
  });
  return { tickets: res.data.tickets, status: res.status };
};

export const getZendeskTicketComments = async (ticketId) => {
  assertZendeskEnabled();
  const res = await zendeskApi.get(`/tickets/${ticketId}/comments`);
  return { data: res.data, status: res.status };
};

export const getZendeskUser = async (userExternalId) => {
  assertZendeskEnabled();
  const res = await zendeskApi.get(zendeskEndpoints.getUsers, {
    params: {
      external_id: userExternalId,
    },
  });
  return { data: res.data, status: res.status };
};
export const createZendeskUser = async (userExternalId, os) => {
  assertZendeskEnabled();
  const body = {
    user: {
      name: `${os} User ${userExternalId}`,
      email: null,
      role: "end-user",
      external_id: userExternalId,
    },
  };
  const res = await zendeskApi.post(zendeskEndpoints.createUser, body);
  return { data: res.data, status: res.status };
};

export const addZendeskComment = async (data) => {
  assertZendeskEnabled();
  const { ticketId, conciergeUserId, desc } = data;
  const body = {
    ticket: {
      comment: {
        author_id: conciergeUserId,
        body: desc,
      },
    },
  };
  const res = await zendeskApi.put(
    `${zendeskEndpoints.updateTicket}/${ticketId}`,
    body
  );
  return { data: res.data, status: res.status };
};

export const createZendeskTicket = async (data) => {
  assertZendeskEnabled();
  const {
    conciergeUser,
    imageToken = null,
    desc,
    onboardEmail = null,
    isTip = false,
  } = data;

  let body;
  if (onboardEmail?.length) {
    body = {
      ticket: {
        comment: {
          body: `User Onboarded\nEmail:${onboardEmail}`,
        },
        subject: `${isDev ? "DEV " : ""}Onboarding Call - ${onboardEmail}`,
        requester: {
          email: onboardEmail,
          name: onboardEmail,
        },
        custom_fields: [
          {
            id: onboardingEmailField,
            value: onboardEmail,
          },
        ],
      },
    };
  } else {
    body = {
      ticket: {
        comment: {
          body: desc,
          uploads: imageToken,
        },
        subject: `${isDev ? "DEV " : ""}Conversation with ${
          conciergeUser.name
        }`,
        external_id: conciergeUser.id,
        submitter_id: conciergeUser.id,
        custom_fields: [
          {
            id: isTipField,
            value: isTip,
          },
        ],
      },
    };
  }

  body.ticket.priority = `${isDev ? "normal" : "urgent"}`;
  body.ticket.assignee_id = `${isDev ? null : zendeskSupport}`;
  body.ticket.custom_fields = [
    ...(body?.ticket?.custom_fields ?? []),
    { id: environmentField, value: config.ENVIRONMENT },
  ];
  body.ticket.email_ccs = isDev
    ? []
    : [{ user_id: zendeskSupport, action: "put" }];
  const res = await zendeskApi.post(zendeskEndpoints.createTicket, body);
  return { data: res.data, status: res.status };
};
