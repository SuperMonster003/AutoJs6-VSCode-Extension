export function awaiter(gGenerator: GeneratorFunction): Promise<any> {
    return new Promise((resolve, reject) => {
        let g: Generator = gGenerator();
        let next = g.next();

        let it = function (result) {
            result.done ? resolve(result.value) : new Promise(resolve => resolve(result.value))
                .then(function _resolve(value) {
                    try {
                        it(g.next(value));
                    } catch (e) {
                        reject(e);
                    }
                }, function _reject(value) {
                    try {
                        it(g.throw(value));
                    } catch (e) {
                        reject(e);
                    }
                });
        }

        it(next);
    });
}