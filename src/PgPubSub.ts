/*!
 * Copyright (c) 2018, imqueue.com <support@imqueue.com>
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
 * REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
 * AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
 * INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
 * LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
 * OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
 * PERFORMANCE OF THIS SOFTWARE.
 */
import { EventEmitter } from 'events';
import { Client, Notification } from 'pg';
import { ident, literal } from 'pg-format';
import { v4 as uuid } from 'uuid';
import {
    AnyJson,
    AnyListener,
    AnyLogger,
    ChannelsListener,
    DefaultOptions,
    ErrorListener,
    MessageListener,
    pack,
    PgClient,
    PgIpLock,
    PgPubSubOptions,
    ReconnectListener,
    RX_LOCK_CHANNEL,
    unpack,
    VoidListener,
} from '.';
import { PgChannelEmitter } from './PgChannelEmitter';
import Timeout = NodeJS.Timeout;

export declare interface PgPubSub {
    on(event: 'end' | 'connect' | 'close', listener: VoidListener     ): this;
    on(event: 'listen' | 'unlisten',       listener: ChannelsListener ): this;
    on(event: 'error',                     listener: ErrorListener    ): this;
    on(event: 'reconnect',                 listener: ReconnectListener): this;
    on(event: 'message',                   listener: MessageListener  ): this;
    on(event: string | symbol,             listener: AnyListener      ): this;

    once(event: 'end' | 'connect' | 'close', listener: VoidListener     ): this;
    once(event: 'listen' | 'unlisten',       listener: ChannelsListener ): this;
    once(event: 'error',                     listener: ErrorListener    ): this;
    once(event: 'reconnect',                 listener: ReconnectListener): this;
    once(event: 'message',                   listener: MessageListener  ): this;
    once(event: string | symbol,             listener: AnyListener      ): this;
}

/**
 * Implements LISTEN/NOTIFY client for PostgreSQL connections.
 *
 * It is a basic public interface of this library, so the end-user is going
 * to work with this class directly to solve his/her tasks.
 *
 * Importing:
 * ~~~typescript
 * import { AnyJson, PgPubSub } from '@imqueue/pg-pubsub';
 * ~~~
 *
 * Instantiation:
 * ~~~typescript
 * const pubSub = new PgPubSub(options)
 * ~~~
 * @see PgPubSubOptions
 *
 * Connecting and listening:
 * ~~~typescript
 * pubSub.on('connect', async () => {
 *     await pubSub.listen('ChannelOne');
 *     await pubSub.listen('ChannelTwo');
 * });
 * // or, even better:
 * pubSub.on('connect', async () => {
 *     await Promise.all(
 *         ['ChannelOne', 'ChannelTwo'].map(channel => channel.listen()),
 *     );
 * });
 * // or. less reliable:
 * await pubSub.connect();
 * await Promise.all(
 *     ['ChannelOne', 'ChannelTwo'].map(channel => channel.listen()),
 * );
 * ~~~
 *
 * Handle messages:
 * ~~~typescript
 * pubSub.on('message', (channel: string, payload: AnyJson) =>
 *     console.log(channel, payload);
 * );
 * // or, using channels
 * pubSub.channels.on('ChannelOne', (payload: AnyJson) =>
 *     console.log(1, payload),
 * );
 * pubSub.channels.on('ChannelTwo', (payload: AnyJson) =>
 *     console.log(2, payload),
 * );
 * ~~~
 *
 * Destroying:
 * ~~~typescript
 * await pubSub.destroy();
 * ~~~
 *
 * Closing and re-using connection:
 * ~~~typescript
 * await pubSub.close();
 * await pubSub.connect();
 * ~~~
 *
 * This close/connect technique may be used when doing some heavy message
 * handling, so while you close, another running copy may handle next
 * messages...
 */
export class PgPubSub extends EventEmitter {

    public readonly pgClient: PgClient;
    public readonly options: PgPubSubOptions;
    public readonly channels: PgChannelEmitter = new PgChannelEmitter();

    private locks: { [channel: string]: PgIpLock } = {};
    private retry: number = 0;

    /**
     * @constructor
     * @param {PgPubSubOptions} options - options
     * @param {AnyLogger} logger - logger
     */
    public constructor(
        options: Partial<PgPubSubOptions>,
        public readonly logger: AnyLogger = console,
    ) {
        super();

        this.options = Object.assign({}, DefaultOptions, options);
        this.pgClient = (this.options.pgClient || new Client(this.options)) as
            PgClient;

        this.pgClient.on('end', this.safeFailure('end'));
        this.pgClient.on('error', this.safeFailure('error'));
        this.pgClient.on('notification', this.onNotification.bind(this));

        this.reconnect = this.reconnect.bind(this);
    }

    /**
     * Establishes re-connectable database connection
     *
     * @return {Promise<void>}
     */
    public async connect(): Promise<void> {
        this.pgClient.once('end', this.reconnect);
        this.pgClient.once('connect', async () => {
            await this.setAppName();
            this.emit('connect');
        });

        await this.pgClient.connect();
    }

    /**
     * Safely closes this database connection
     *
     * @return {Promise<void>}
     */
    public async close(): Promise<void> {
        this.pgClient.removeListener('end', this.reconnect);
        await this.pgClient.end();
        this.pgClient.removeAllListeners();
        this.emit('close');
    }

    /**
     * Starts listening given channel. If singleListener option is set to
     * true, it guarantees that only one process would be able to listen
     * this channel at a time.
     *
     * @param {string} channel - channel name to listen
     * @return {Promise<void>}
     */
    public async listen(channel: string): Promise<void> {
        if (this.options.singleListener) {
            const lock = await this.lock(channel);

            // istanbul ignore else
            if (await lock.acquire()) {
                await this.pgClient.query(`LISTEN ${ident(channel)}`);
                this.emit('listen', channel);
            }
        } else {
            await this.pgClient.query(`LISTEN ${ident(channel)}`);
            this.locks[channel] = true as any;
            this.emit('listen', channel);
        }
    }

    /**
     * Stops listening of the given chanel, and, if singleListener option is
     * set to true - will release an acquired lock (if it was settled).
     *
     * @param {string} channel - channel name to unlisten
     * @return {Promise<void>}
     */
    public async unlisten(channel: string): Promise<void> {
        await this.pgClient.query(`UNLISTEN ${ident(channel)}`);

        if (this.options.singleListener) {
            await (await this.lock(channel)).release();
        } else if (this.locks[channel]) {
            await this.locks[channel].destroy();
            delete this.locks[channel];
        }

        this.emit('unlisten', [channel]);
    }

    /**
     * Stops listening all connected channels, and, if singleListener option
     * is set to true - will release all acquired locks (if any was settled).
     *
     * @return {Promise<void>}
     */
    public async unlistenAll(): Promise<void> {
        await this.pgClient.query(`UNLISTEN *`);

        if (this.options.singleListener) {
            await this.release();
        } else {
            await Promise.all(Object.keys(this.locks)
                .map(channel => this.locks[channel].destroy()));
            this.locks = {};
        }

        this.emit('unlisten', Object.keys(this.locks));
    }

    /**
     * Performs NOTIFY to a given chanel with a given payload to all
     * listening subscribers
     *
     * @param {string} channel - channel to publish to
     * @param {AnyJson} payload - payload to publish for subscribers
     * @return {Promise<void>}
     */
    public async notify(channel: string, payload: AnyJson): Promise<void> {
        await this.pgClient.query(
            `NOTIFY ${ident(channel)}, ${literal(pack(payload, this.logger))}`,
        );
    }

    /**
     * Returns list of all active subscribed channels
     *
     * @return {string[]}
     */
    public activeChannels(): string[] {
        return Object.keys(this.locks).filter(channel =>
            this.locks[channel].isAcquired(),
        );
    }

    /**
     * Returns list of all inactive channels (those which are known, but
     * not actively listening at a time)
     *
     * @return {string[]}
     */
    public inactiveChannels(): string[] {
        return Object.keys(this.locks).filter(channel =>
            !this.locks[channel].isAcquired(),
        );
    }

    /**
     * Returns list of all known channels, despite the fact they are listening
     * (active) or not (inactive).
     *
     * @return {string[]}
     */
    public allChannels(): string[] {
        return Object.keys(this.locks);
    }

    /**
     * Destroys this object properly, destroying all locks,
     * closing all connections and removing all event listeners to avoid
     * memory leaking. So whenever you need to destroy an object
     * programmatically - use this method.
     * Note, that after destroy it is broken and should be removed from memory.
     *
     * @return {Promise<void>}
     */
    public async destroy(): Promise<void> {
        await Promise.all([this.close(), PgIpLock.destroy()]);
        this.channels.removeAllListeners();
        this.removeAllListeners();
    }

    /**
     * Database notification event handler
     *
     * @param {Notification} message - database message data
     * @return {Promise<void>}
     */
    private async onNotification(message: Notification): Promise<void> {
        if (RX_LOCK_CHANNEL.test(message.channel)) {
            // as we use the same connection with locks mechanism
            // we should avoid pub/sub client to parse lock channels data
            return ;
        }

        if (this.options.singleListener) {
            if (!(await this.lock(message.channel)).isAcquired()) {
                return; // we are not really a listener
            }
        }

        const payload = unpack(message.payload);

        this.emit('message', message.channel, payload);
        this.channels.emit(message.channel, payload);
    }

    /**
     * Failure handler
     *
     * @param {string} event
     * @return {() => Promise<void>}
     */
    private safeFailure(event: string): () => Promise<void> {
        return async () => {
            if (this.options.singleListener) {
                await this.release();
            }

            this.emit(event);
        };
    }

    /**
     * On reconnect event emitter
     *
     * @return {Promise<void>}
     */
    private async onReconnect(): Promise<void> {
        await Promise.all(Object.keys(this.locks).map(channel =>
            this.listen(channel),
        ));

        this.emit('reconnect', this.retry);
        this.retry = 0;
    }

    /**
     * Reconnect routine, used for implementation of auto-reconnecting db
     * connection
     *
     * @return {number}
     */
    private reconnect(): Timeout {
        return setTimeout(async () => {
            if (this.options.retryLimit <= ++this.retry) {
                const msg = `Connect failed after ${this.retry} retries...`;

                this.emit('error', new Error(msg));

                return this.close();
            }

            this.once('connect', this.onReconnect.bind(this));
            await this.connect();
        },

        this.options.retryDelay) as Timeout;
    }

    /**
     * Instantiates and returns process lock for a given channel or returns
     * existing one
     *
     * @access private
     * @param {string} channel
     * @return {Promise<PgIpLock>}
     */
    private async lock(channel: string): Promise<PgIpLock> {
        if (!this.locks[channel]) {
            this.locks[channel] = new PgIpLock(
                channel,
                this.pgClient,
                this.logger,
                this.options.acquireInterval,
            );
            await this.locks[channel].init();
            this.locks[channel].onRelease(chan => this.listen(chan));
        }

        return this.locks[channel];
    }

    /**
     * Releases all acquired locks in current session
     *
     * @access private
     * @return {Promise<void>}
     */
    private async release(): Promise<void> {
        await Promise.all(Object.keys(this.locks).map(async channel => {
            const lock = await this.lock(channel);

            if (lock.isAcquired()) {
                await lock.release();
            }
        }));
    }

    /**
     * Sets application_name for this connection as unique identifier
     *
     * @return {Promise<void>}
     */
    private async setAppName(): Promise<void> {
        try {
            this.pgClient.appName = uuid();
            await this.pgClient.query(
                `SET APPLICATION_NAME TO '${this.pgClient.appName}'`,
            );
        } catch (err) { /* ignore */ }
    }
}
