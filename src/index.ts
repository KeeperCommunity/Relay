import bodyParser from 'body-parser';
import cors from 'cors';
import express, { Express, Request, Response, NextFunction } from 'express';
import morgan from 'morgan';
import cron from 'node-cron';
import config from './config';
import { localDevelopmentRoutes } from './localDevelopment';
import Routes from './routes/routes';
import { syncExchangeRates } from './services/rates';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { startChannel } from './services/channel';
import { getLatestFeeData } from './utils/feeInsightCronJob';
import { deleteExpiredRemoteKeyData } from "./services/app";

class Relay {
  private app: Express;
  private routes: Routes;
  private channel: any;

  constructor() {
    this.app = express();
    this.app.use(cors());
    this.routes = new Routes(this.app);
    this.configure();
    this.invoke();
    if (!config.LOCAL_DEV) this.startCrons();
    this.initializeSocketIO();
  }

  private initializeSocketIO(): void {
    const httpServer = createServer(this.app);
    this.channel = new Server(httpServer, {
      cors: { methods: ['GET', 'POST', 'OPTIONS'] },
    });
    const WS_PORT = config.WS_PORT;
    httpServer.listen(WS_PORT, () => {
      console.log(
        `⚡️[Channel]: Keeper channel is running at ${this.channel.path()} : ${WS_PORT}`
      );
      startChannel(this.channel);
    });
  }

  private configure(): void {
    this.app.set('router', express.Router());
    this.app.set('config', config);
    this.app.use(morgan('combined'));
    this.app.use(bodyParser.json({ limit: '50mb' }));
    this.app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
    if (config.LOCAL_DEV) this.app.use(localDevelopmentRoutes);
    this.app.all('*', this.checkAuth);
    this.app.use(this.routes.initializeRoutes());
    this.app.use(express.static('public'));
  }

  private checkAuth(req: Request, res: Response, next: NextFunction) {
    if (req.path == '/') return next();
    try {
      if (config.HEXA_ID === req.get('HEXA-ID')) {
        next();
      } else {
        next();
      }
    } catch (error) {
      console.log(error);
      return res.status(401).json({ err: 'Unauthorized request' });
    }
  }

  private invoke(): void {
    const PORT = config.PORT;

    this.app.listen(PORT, () => {
      console.log(
        `Zendesk integration: ${config.ZENDESK_ENABLED ? "enabled" : "disabled"}`,
      );
      console.log(
        `Relay listening on port: ${config.PORT}\nconfiguration :: version: ${config.VERSION}; env: ${config.ENVIRONMENT}`,
      );
    });
  }

  private startCrons(): void {
    // exchange rates job: runs every hour
    cron.schedule('0 0-23 * * *', async () => {
      try {
        console.log('Synching ex-rates');
        await syncExchangeRates();
      } catch (err) {
        console.log('Ex-rates sync: failed', { err });
      }
    });

    cron.schedule("*/8 * * * *", () => {
      try{
        getLatestFeeData();
      }catch(err){
        console.log("Cron Job failed",err)
      }
    });

      cron.schedule("0 0 * * *", async () => {
        // run every midnight to delete expired remote keys
        try {
          await deleteExpiredRemoteKeyData();
        } catch (err) {
          console.log("Cron Job failed", err);
        }
      });
    

  }
}
new Relay();
