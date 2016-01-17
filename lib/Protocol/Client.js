/*
 * Copyright (c) 2015, Oracle and/or its affiliates. All rights reserved.
 *
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU General Public License as
 * published by the Free Software Foundation; version 2 of the
 * License.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program; if not, write to the Free Software
 * Foundation, Inc., 51 Franklin St, Fifth Floor, Boston, MA
 * 02110-1301  USA
 */

"use strict";

const Messages = require('./Messages'),
    Encoding = require('./Encoding'),
    protobuf = new (require('./protobuf.js'))(Messages),
    WorkQueue = require('./../WorkQueue'),
    handlers = require('./ResponseHandler'),
    Expressions = require('../Expressions'),
    DataType = require('./Datatype'),
    tls = require('tls');

/**
 * Main Protocol class
 * @param stream {stream}
 * @constructor
 */
function Client(stream) {
    this._stream = stream;

    this._workQueue = new WorkQueue();

    this._stream.on('data', (data) => { return this.handleServerMessage(data); });
    this._stream.on('close', () => { return this.handleServerClose(); });
}

module.exports = Client;

Client.dataModel = {
    "DOCUMENT": Messages.enums.DataModel.DOCUMENT,
    "TABLE": Messages.enums.DataModel.TABLE
};

Client.updateOperations = {
    "SET": Messages.messages['Mysqlx.Crud.UpdateOperation'].enums.UpdateType.SET,
    "ITEM_REMOVE": Messages.messages['Mysqlx.Crud.UpdateOperation'].enums.UpdateType.ITEM_REMOVE,
    "ITEM_SET": Messages.messages['Mysqlx.Crud.UpdateOperation'].enums.UpdateType.ITEM_SET,
    "ITEM_REPLACE": Messages.messages['Mysqlx.Crud.UpdateOperation'].enums.UpdateType.ITEM_REPLACE,
    "ITEM_MERGE": Messages.messages['Mysqlx.Crud.UpdateOperation'].enums.UpdateType.ITEM_MERGE,
    "ARRAY_INSERT": Messages.messages['Mysqlx.Crud.UpdateOperation'].enums.UpdateType.ARRAY_INSERT,
    "ARRAY_APPEND": Messages.messages['Mysqlx.Crud.UpdateOperation'].enums.UpdateType.ARRAY_APPEND
};

// TODO - This is a hack, see also TODO in ResponseHandler.prototype.sendMessage
Client.serverGoneMessageId = -1;

Client.prototype.enableSSL = function (options) {
    options = options || {};
    options.isServer = false;

    return this.capabilitiesSet({tls: true}).then(() => {
        this._stream = new tls.TLSSocket(this._stream, options);
        this._stream.on('data', function (data) { return this.handleServerMessage(data); });
        this._stream.on('close', function () { return this.handleServerClose(); });
        return true;
    });
};

/**
 * Encode data using protobuf and add MySQLx protocol header
 * @param messageId
 * @param data
 */
Client.prototype.encodeMessage = function (messageId, data, messages) {
    messages = messages || Encoding.clientMessages;
    return Encoding.encodeMessage(messageId, data, messages);
};

Client.prototype.decodeMessage = function (data, offset, messages) {
    messages = messages || Encoding.serverMessages;
    return Encoding.decodeMessage(data, offset, messages);
};

var noticeDecoders = {
    1: "Mysqlx.Notice.Warning",
    2: "Mysqlx.Notice.SessionVariableChanged",
    3: "Mysqlx.Notice.SessionStateChanged"
};

const sessionStateParameters = {};
Object.getOwnPropertyNames(Messages.messages[noticeDecoders[3]].enums.Parameter).forEach((name) => {
    sessionStateParameters[Messages.messages[noticeDecoders[3]].enums.Parameter[name]] = name;
});

Client.decodeNotice = function (notice) {
    let retval = {
        type: notice.type,
        name: noticeDecoders[notice.type],
        notice: protobuf.decode(noticeDecoders[notice.type], notice.payload)
    };

    if (notice.type === 3) {
        retval.notice.paramName = sessionStateParameters[retval.notice.param];
    }

    if (retval.notice.value) {
        retval.notice.value = DataType.decodeScalar(retval.notice.value);
    }

    return retval;
};

Client.prototype.handleServerMessage = function (message) {
    let payloadLen = 0;
    for (var offset = 0; offset < message.length; offset += payloadLen) {
        var current = this.decodeMessage(message, offset);

        if (current.messageId === Messages.ServerMessages.NOTICE && current.decoded.scope === Messages.messages['Mysqlx.Notice.Frame'].enums.Scope.GLOBAL) {
            console.log("TODO: Need to handle out of band message");
            console.log(Client.decodeNotice(current.decoded));
        } else {
            this._workQueue.process(current);
        }
        payloadLen = current.payloadLen;
    }
};

Client.prototype.handleServerClose = function () {
    while (this._workQueue.hasMore()) {
        this._workQueue.process(Client.serverGoneMessageId);
    }
};


Client.prototype.capabilitiesGet = function (properties) {
    const buffer = this.encodeMessage(Messages.ClientMessages.CON_CAPABILITIES_GET, {});

    const handler = new handlers.CapabilitiesGetHandler(this);
    return handler.sendMessage(this._workQueue, this._stream, buffer);
};

Client.prototype.capabilitiesSet = function (properties) {
    const data = {
        capabilities: {
            capabilities: []
        }
    };

    for (let key in properties) {
        data.capabilities.capabilities.push({
            name: key,
            value: DataType.encode(properties[key])
        });
    }

    const buffer = this.encodeMessage(Messages.ClientMessages.CON_CAPABILITIES_SET, data);

    const handler = new handlers.OkHandler(this);
    return handler.sendMessage(this._workQueue, this._stream, buffer);
};


Client.prototype.authenticate = function (authenticator) {
    const data = {
        mech_name: authenticator.name,
        auth_data: authenticator.getInitialAuthData()
    };

    const buffer = this.encodeMessage(Messages.ClientMessages.SESS_AUTHENTICATE_START, data);

    const handler = new handlers.AuthenticationHandler(authenticator, this);
    return handler.sendMessage(this._workQueue, this._stream, buffer);
};

Client.prototype.authenticateContinue = function (auth_data, handler) {
    const data = {
        auth_data: auth_data
    };
    const buffer = this.encodeMessage(Messages.ClientMessages.SESS_AUTHENTICATE_CONTINUE, data);
    handler.sendDirect(this._stream, buffer);
};

Client.prototype.close = function () {
    const buffer = this.encodeMessage(Messages.ClientMessages.CON_CLOSE),
        handler = new handlers.OkHandler();
    return handler.sendMessage(this._workQueue, this._stream, buffer);
};

Client.prototype.crudInsert = function (schema, collection, model, rows, projection) {
    projection = projection || [];

    if (!rows.length) {
        throw new Error("No document provided for Crud::Insert");
    }

    const data = {
        collection: {
            schema: schema,
            name: collection
        },
        data_model: model,
        projection: projection,
        row: [
        ]
    };

    rows.forEach(function (row) {
        const fields = row.map(function (field) {
            if (model === Client.dataModel.DOCUMENT) {
                field = JSON.stringify(field);
            }
            return {
                    type: Messages.messages['Mysqlx.Expr.Expr'].enums.Type.LITERAL,
                    literal: DataType.encodeScalar(field)
            };
        });

        data.row.push({ field: fields });
    });

    const buffer = this.encodeMessage(Messages.ClientMessages.CRUD_INSERT, data),
        handler = new handlers.SqlResultHandler();
    return handler.sendMessage(this._workQueue, this._stream, buffer);
};

Client.prototype.crudFind = function (session, schema, collection, model, projection, criteria, limit, rowcb, metacb) {
    const data = {
        collection: {
            schema: schema,
            name: collection
        },
        data_model: model,
        projection: projection,
        order: [],
        grouping: []
    };

    if (limit && limit.count) {
        data.limit = {
            row_count: limit.count
        };
        if (limit.offset) {
            data.limit.offset = limit.offset;
        }
    }

    criteria = Expressions.parse(criteria);

    if (criteria) {
        data.criteria = criteria;
    }

    const buffer = this.encodeMessage(Messages.ClientMessages.CRUD_FIND, data),
        handler = new handlers.SqlResultHandler(rowcb, metacb);
    return handler.sendMessage(this._workQueue, this._stream, buffer);
};

Client.prototype.crudModify = function (session, schema, collection, dataModel, criteria, operations) {
    const data = {
        collection: {
            schema: schema,
            name: collection
        },
        data_model: dataModel,
        operation: operations
    };

    criteria = Expressions.parse(criteria);
    if (criteria) {
        data.criteria = criteria;
    }

    const buffer = this.encodeMessage(Messages.ClientMessages.CRUD_UPDATE, data),
        handler = new handlers.SqlResultHandler();
    return handler.sendMessage(this._workQueue, this._stream, buffer);
};

Client.prototype.crudRemove = function (session, schema, collection, model, criteria, limit, rowcb, metacb) {
    const data = {
        collection: {
            schema: schema,
            name: collection
        },
        data_model: model,
        order: []
    };

    if (limit && limit.count) {
        data.limit = {
            row_count: limit.count
        };
        if (limit.offset) {
            data.limit.offset = limit.offset;
        }
    }

    criteria = Expressions.parse(criteria);
    if (criteria) {
        data.criteria = criteria;
    }

    const buffer = this.encodeMessage(Messages.ClientMessages.CRUD_DELETE, data),
        handler = new handlers.SqlResultHandler();
    return handler.sendMessage(this._workQueue, this._stream, buffer);
};

Client.prototype.sqlStmtExecute = function (stmt, args, rowcb, metacb, namespace) {
    namespace = namespace || "sql";
    const data = {
        namespace: namespace,
        stmt: stmt
    };
    if (args) {
        data.args = [];
        args.forEach(function (arg) {
            data.args.push(DataType.encode(arg))
        });
    }

    const buffer = this.encodeMessage(Messages.ClientMessages.SQL_STMT_EXECUTE, data),
        handler = new handlers.SqlResultHandler(rowcb, metacb);
    return handler.sendMessage(this._workQueue, this._stream, buffer);
};