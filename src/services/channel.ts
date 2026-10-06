import { Server } from 'socket.io';
import * as uuid from 'uuid';
import {
  BITBOX_HEALTHCHECK,
  BITBOX_REGISTER,
  BITBOX_SETUP,
  BITBOX_SIGN,
  CHANNEL_MESSAGE,
  JOIN_CHANNEL,
  LEDGER_HEALTHCHECK,
  LEDGER_REGISTER,
  LEDGER_SETUP,
  LEDGER_SIGN,
  REGISTRATION_SUCCESS,
  SIGNED_TX,
  TREZOR_HEALTHCHECK,
  TREZOR_SETUP,
  TREZOR_SIGN,
  WHIRLPOOL_ERROR,
  WHIRLPOOL_FAILURE,
  WHIRLPOOL_LISTEN,
  WHIRLPOOL_SUCCESS,
  WHIRLPOOL_WORKING,
} from "./constants";

const dotenv = require("dotenv");
dotenv.config();

export const startChannel = (io: Server) => {
  io.engine.generateId = (req) => {
    return uuid.v4(); // must be unique across all Socket.IO servers
  };

  io.on("connection", (socket) => {
    console.log(`${socket.id} is connected 👋`);

    socket.on(CHANNEL_MESSAGE, ({ room, network, data }) => {
      try {
        if (network) {
          socket.to(room).emit(CHANNEL_MESSAGE, { room, network, data });
        }
      } catch (error) {
        console.log("🚀 ~ socket.on ~ error:", error);
      }
    });

    socket.on(JOIN_CHANNEL, async ({ room, network, requestData }) => {
      socket.join(room);
      if (network) {
        socket.to(room).emit(CHANNEL_MESSAGE, { room, network, requestData });
      }
    });

    socket.on(BITBOX_SETUP, ({ room, data }) => {
      socket.to(room).emit(BITBOX_SETUP, data);
    });

    socket.on(BITBOX_HEALTHCHECK, ({ room, data }) => {
      socket.to(room).emit(BITBOX_HEALTHCHECK, data);
    });

    socket.on(BITBOX_REGISTER, ({ room, data = null }) => {
      socket.to(room).emit(BITBOX_REGISTER, { room, data });
    });

    socket.on(TREZOR_SETUP, ({ room, data }) => {
      socket.to(room).emit(TREZOR_SETUP, data);
    });

    socket.on(TREZOR_HEALTHCHECK, ({ room, data }) => {
      socket.to(room).emit(TREZOR_HEALTHCHECK, data);
    });

    socket.on(TREZOR_SIGN, ({ room, data = null }) => {
      socket.to(room).emit(TREZOR_SIGN, { room, data });
    });

    socket.on(BITBOX_SIGN, ({ room, data = null }) => {
      socket.to(room).emit(BITBOX_SIGN, { room, data });
    });

    socket.on(LEDGER_SETUP, ({ room, data }) => {
      socket.to(room).emit(LEDGER_SETUP, data);
    });

    socket.on(LEDGER_HEALTHCHECK, ({ room, data }) => {
      socket.to(room).emit(LEDGER_HEALTHCHECK, data);
    });

    socket.on(LEDGER_REGISTER, ({ room, data = null }) => {
      socket.to(room).emit(LEDGER_REGISTER, { room, data });
    });

    socket.on(LEDGER_SIGN, ({ room, data = null }) => {
      socket.to(room).emit(LEDGER_SIGN, { room, data });
    });

    socket.on(SIGNED_TX, ({ room, data }) => {
      socket.to(room).emit(SIGNED_TX, { data });
    });

    socket.on(REGISTRATION_SUCCESS, ({ room, data }) => {
      socket.to(room).emit(REGISTRATION_SUCCESS, { data });
    });

    socket.on(WHIRLPOOL_LISTEN, ({ room }) => {
      console.log("App listening for whirlpool events:\n");
      socket.join(room);
    });

    socket.on(WHIRLPOOL_WORKING, ({ data, room }) => {
      socket.to(room).emit(WHIRLPOOL_WORKING, { data });
    });

    socket.on(WHIRLPOOL_ERROR, ({ data, room }) => {
      socket.to(room).emit(WHIRLPOOL_ERROR, { data });
    });

    socket.on(WHIRLPOOL_FAILURE, ({ data, room }) => {
      socket.to(room).emit(WHIRLPOOL_FAILURE, { data });
    });

    socket.on(WHIRLPOOL_SUCCESS, ({ data, room }) => {
      socket.to(room).emit(WHIRLPOOL_SUCCESS, { data });
    });

    socket.on("disconnect", (reason) => {
      console.log(`disconnect ${socket.id} due to ${reason}`);
    });
  });

  io.engine.on("connection_error", (err) => {
    console.log(err.message);
  });
};
