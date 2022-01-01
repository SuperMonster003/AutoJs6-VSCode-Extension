import * as os from 'os';
import * as crypto from 'crypto';

import {StringDecoder} from 'string_decoder';

const DEBUG = true;

export function logDebug(message?: any, ...optionalParams: any[]) {
    if (DEBUG) {
        console.log.apply(console, arguments);
    }
}

export function getNicAddress(): string {
    let interfaces = os.networkInterfaces();
    for (let nic in interfaces) {
        let infos = interfaces[nic];
        for (let info of infos) {
            if (info.family === 'IPv4' && info.address !== '127.0.0.1' && !info.internal) {
                return info.address;
            }
        }
    }
}

export function buffToString(buff) {
    const decoder = new StringDecoder('utf8');
    return decoder.write(buff);
}

export function SHA1(str): string {
    return crypto.createHash('sha1').update(str).digest().toString('base64');
}