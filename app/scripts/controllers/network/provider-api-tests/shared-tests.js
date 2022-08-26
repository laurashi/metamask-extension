import nock from 'nock';
import {
  mockingInfuraCommunications,
  withInfuraClient,
  buildMockParamsWithoutBlockParamAt,
  buildMockParamsWithBlockParamAt,
  buildRequestWithReplacedBlockParam,
} from './helpers';

const originalSetTimeout = setTimeout;
const TIME_TO_WAIT_FOR_NEXT_INFURA_RETRY = 50;

/**
 * Defines tests which exercise the behavior exhibited by an RPC method that
 * does not support params (which affects how the method is cached).
 */
/* eslint-disable-next-line jest/no-export */
export function testsForRpcMethodThatDoesNotSupportParams(method) {
  describe('behaves like an RPC method that does not support params', () => {
    it('does not hit Infura more than once for identical requests', async () => {
      const requests = [{ method }, { method }];
      const mockResults = ['first result', 'second result'];

      await mockingInfuraCommunications(async (comms) => {
        // The first time a block-cacheable request is made, the latest block
        // number is retrieved through the block tracker first. It doesn't
        // matter what this is — it's just used as a cache key.
        comms.mockNextBlockTrackerRequest();
        comms.mockInfuraRpcCall({
          request: requests[0],
          response: { result: mockResults[0] },
        });
        const results = await withInfuraClient(({ makeRpcCallsInSeries }) =>
          makeRpcCallsInSeries(requests),
        );

        expect(results).toStrictEqual([mockResults[0], mockResults[0]]);
      });
    });

    it('hits Infura and does not reuse the result of a previous request if the latest block number was updated since', async () => {
      const requests = [{ method }, { method }];
      const mockResults = ['first result', 'second result'];

      await mockingInfuraCommunications(async (comms) => {
        // Note that we have to mock these requests in a specific order. The
        // first block tracker request occurs because of the first RPC request.
        // The second block tracker request, however, does not occur because of
        // the second RPC request, but rather because we call `clock.runAll()`
        // below.
        comms.mockNextBlockTrackerRequest({ blockNumber: '0x1' });
        comms.mockInfuraRpcCall({
          request: requests[0],
          response: { result: mockResults[0] },
        });
        comms.mockNextBlockTrackerRequest({ blockNumber: '0x2' });
        comms.mockInfuraRpcCall({
          request: requests[1],
          response: { result: mockResults[1] },
        });

        const results = await withInfuraClient(async (client) => {
          const firstResult = await client.makeRpcCall(requests[0]);
          // Proceed to the next iteration of the block tracker so that a new
          // block is fetched and the current block is updated
          client.clock.runAll();
          const secondResult = await client.makeRpcCall(requests[1]);
          return [firstResult, secondResult];
        });

        expect(results).toStrictEqual(mockResults);
      });
    });

    it.each([null, undefined, '\u003cnil\u003e'])(
      'does not reuse the result of a previous request if it was `%s`',
      async (emptyValue) => {
        const requests = [{ method }, { method }];
        const mockResults = [emptyValue, 'some result'];

        await mockingInfuraCommunications(async (comms) => {
          // The first time a block-cacheable request is made, the latest block
          // number is retrieved through the block tracker first. It doesn't
          // matter what this is — it's just used as a cache key.
          comms.mockNextBlockTrackerRequest();
          comms.mockInfuraRpcCall({
            request: requests[0],
            response: { result: mockResults[0] },
          });
          comms.mockInfuraRpcCall({
            request: requests[1],
            response: { result: mockResults[1] },
          });

          const results = await withInfuraClient(({ makeRpcCallsInSeries }) =>
            makeRpcCallsInSeries(requests),
          );

          expect(results).toStrictEqual(mockResults);
        });
      },
    );

    it('queues requests while a previous identical call is still pending, then runs the queue when it finishes, reusing the result from the first request', async () => {
      const requests = [{ method }, { method }, { method }];
      const mockResults = ['first result', 'second result', 'third result'];

      await mockingInfuraCommunications(async (comms) => {
        // The first time a block-cacheable request is made, the latest block
        // number is retrieved through the block tracker first. It doesn't
        // matter what this is — it's just used as a cache key.
        comms.mockNextBlockTrackerRequest();
        comms.mockInfuraRpcCall({
          request: requests[0],
          response: { result: mockResults[0] },
          delay: 100,
        });
        comms.mockInfuraRpcCall({
          request: requests[1],
          response: { result: mockResults[1] },
        });
        comms.mockInfuraRpcCall({
          request: requests[2],
          response: { result: mockResults[2] },
        });

        const results = await withInfuraClient(async (client) => {
          const resultPromises = [
            client.makeRpcCall(requests[0]),
            client.makeRpcCall(requests[1]),
            client.makeRpcCall(requests[2]),
          ];
          const firstResult = await resultPromises[0];
          // The inflight cache middleware uses setTimeout to run the handlers,
          // so run them now
          client.clock.runAll();
          const remainingResults = await Promise.all(resultPromises.slice(1));
          return [firstResult, ...remainingResults];
        });

        expect(results).toStrictEqual([
          mockResults[0],
          mockResults[0],
          mockResults[0],
        ]);
      });
    });

    it('throws a custom error if the request to Infura returns a 405 response', async () => {
      await mockingInfuraCommunications(async (comms) => {
        const request = { method };

        // The first time a block-cacheable request is made, the latest block
        // number is retrieved through the block tracker first. It doesn't
        // matter what this is — it's just used as a cache key.
        comms.mockNextBlockTrackerRequest();
        comms.mockInfuraRpcCall({
          request,
          response: {
            httpStatus: 405,
          },
        });
        const promiseForResult = withInfuraClient(async ({ makeRpcCall }) =>
          makeRpcCall(request),
        );

        await expect(promiseForResult).rejects.toThrow(
          'The method does not exist / is not available',
        );
      });
    });

    it('throws a custom error if the request to Infura returns a 429 response', async () => {
      await mockingInfuraCommunications(async (comms) => {
        const request = { method };

        // The first time a block-cacheable request is made, the latest block
        // number is retrieved through the block tracker first. It doesn't
        // matter what this is — it's just used as a cache key.
        comms.mockNextBlockTrackerRequest();
        comms.mockInfuraRpcCall({
          request,
          response: {
            httpStatus: 429,
          },
        });
        const promiseForResult = withInfuraClient(async ({ makeRpcCall }) =>
          makeRpcCall(request),
        );

        await expect(promiseForResult).rejects.toThrow(
          'Request is being rate limited',
        );
      });
    });

    it('throws a custom error if the request to Infura returns a response that is not 405, 429, 503, or 504', async () => {
      await mockingInfuraCommunications(async (comms) => {
        const request = { method };

        // The first time a block-cacheable request is made, the latest block
        // number is retrieved through the block tracker first. It doesn't
        // matter what this is — it's just used as a cache key.
        comms.mockNextBlockTrackerRequest();
        comms.mockInfuraRpcCall({
          request,
          response: {
            id: 12345,
            jsonrpc: '2.0',
            error: 'some error',
            httpStatus: 420,
          },
        });
        const promiseForResult = withInfuraClient(async ({ makeRpcCall }) =>
          makeRpcCall(request),
        );

        await expect(promiseForResult).rejects.toThrow(
          '{"id":12345,"jsonrpc":"2.0","error":"some error"}',
        );
      });
    });

    [503, 504].forEach((httpStatus) => {
      it(`retries the request to Infura up to 5 times if it returns a ${httpStatus} response, returning the successful result if there is one on the 5th try`, async () => {
        await mockingInfuraCommunications(async (comms) => {
          const request = { method };

          // The first time a block-cacheable request is made, the latest block
          // number is retrieved through the block tracker first. It doesn't
          // matter what this is — it's just used as a cache key.
          comms.mockNextBlockTrackerRequest();
          // Here we have the request fail for the first 4 tries, then succeed
          // on the 5th try.
          comms.mockInfuraRpcCall({
            request,
            response: {
              error: 'Some error',
              httpStatus,
            },
            times: 4,
          });
          comms.mockInfuraRpcCall({
            request,
            response: {
              result: 'the result',
              httpStatus: 200,
            },
          });
          const result = await withInfuraClient(
            async ({ makeRpcCall, clock }) => {
              // Note that we have to manually capture the value that the
              // promise that `makeRpcCall` returns when it resolves or is
              // rejected using `then`/`catch` instead of `try`/`catch` because
              // the resolution/rejection occurs out of band. To be more
              // specific, the promise will be fulfilled while the `while` loop
              // below is running. This means that if we did not attach `catch`
              // to the promise, Node would complain that the promise had a
              // unhandled rejection. So we attach `catch` to capture the
              // rejection and we also attach `then` to capture the resolution
              // and check them after the loop ends.

              let capturedResolutionValue;
              let capturedRejectionValue;
              makeRpcCall(request)
                .then((resolutionValue) => {
                  capturedResolutionValue = resolutionValue;
                })
                .catch((rejectionValue) => {
                  capturedRejectionValue = rejectionValue;
                });

              // ESLint complains that capturedResolutionValue and
              // capturedRejectionValue don't change during the loop, but thanks
              // to the magic of asynchronicity, they do
              while (
                /* eslint-disable-next-line no-unmodified-loop-condition */
                capturedResolutionValue === undefined &&
                /* eslint-disable-next-line no-unmodified-loop-condition */
                capturedRejectionValue === undefined
              ) {
                clock.runAll();
                await new Promise((resolve) =>
                  originalSetTimeout(
                    resolve,
                    TIME_TO_WAIT_FOR_NEXT_INFURA_RETRY,
                  ),
                );
              }

              if (capturedRejectionValue !== undefined) {
                return Promise.reject(capturedRejectionValue);
              }
              return Promise.resolve(capturedResolutionValue);
            },
          );

          expect(result).toStrictEqual('the result');
        });
      });

      it(`causes a request to fail with a custom error if the request to Infura returns a ${httpStatus} response 5 times in a row`, async () => {
        await mockingInfuraCommunications(async (comms) => {
          const request = { method };

          // The first time a block-cacheable request is made, the latest block
          // number is retrieved through the block tracker first. It doesn't
          // matter what this is — it's just used as a cache key.
          comms.mockNextBlockTrackerRequest();
          comms.mockInfuraRpcCall({
            request,
            response: {
              error: 'Some error',
              httpStatus,
            },
            times: 5,
          });
          const promiseForResult = withInfuraClient(
            async ({ makeRpcCall, clock }) => {
              // Note that we have to manually capture the value that the
              // promise that `makeRpcCall` returns when it resolves or is
              // rejected using `then`/`catch` instead of `try`/`catch` because
              // the resolution/rejection occurs out of band. To be more
              // specific, the promise will be fulfilled while the `while` loop
              // below is running. This means that if we did not attach `catch`
              // to the promise, Node would complain that the promise had a
              // unhandled rejection. So we attach `catch` to capture the
              // rejection and we also attach `then` to capture the resolution
              // and check them after the loop ends.

              let capturedResolutionValue;
              let capturedRejectionValue;
              makeRpcCall(request)
                .then((resolutionValue) => {
                  capturedResolutionValue = resolutionValue;
                })
                .catch((rejectionValue) => {
                  capturedRejectionValue = rejectionValue;
                });

              // ESLint complains that capturedResolutionValue and
              // capturedRejectionValue don't change during the loop, but thanks
              // to the magic of asynchronicity, they do
              while (
                /* eslint-disable-next-line no-unmodified-loop-condition */
                capturedResolutionValue === undefined &&
                /* eslint-disable-next-line no-unmodified-loop-condition */
                capturedRejectionValue === undefined
              ) {
                clock.runAll();
                await new Promise((resolve) =>
                  originalSetTimeout(
                    resolve,
                    TIME_TO_WAIT_FOR_NEXT_INFURA_RETRY,
                  ),
                );
              }

              if (capturedRejectionValue !== undefined) {
                return Promise.reject(capturedRejectionValue);
              }
              return Promise.resolve(capturedResolutionValue);
            },
          );

          await expect(promiseForResult).rejects.toThrow(
            /^InfuraProvider - cannot complete request\. All retries exhausted\..+Gateway timeout/su,
          );
        });
      });
    });

    ['ETIMEDOUT', 'ECONNRESET', 'SyntaxError'].forEach((errorMessagePrefix) => {
      it(`retries the request to Infura up to 5 times if an "${errorMessagePrefix}" error is thrown while making the request, returning the successful result if there is one on the 5th try`, async () => {
        await mockingInfuraCommunications(async (comms) => {
          const request = { method };

          // The first time a block-cacheable request is made, the latest block
          // number is retrieved through the block tracker first. It doesn't
          // matter what this is — it's just used as a cache key.
          comms.mockNextBlockTrackerRequest();
          // Here we have the request fail for the first 4 tries, then succeed
          // on the 5th try.
          comms.mockInfuraRpcCall({
            request,
            error: `${errorMessagePrefix}: Some message`,
            times: 4,
          });
          comms.mockInfuraRpcCall({
            request,
            response: {
              result: 'the result',
              httpStatus: 200,
            },
          });
          const result = await withInfuraClient(
            async ({ makeRpcCall, clock }) => {
              // Note that we have to manually capture the value that the
              // promise that `makeRpcCall` returns when it resolves or is
              // rejected using `then`/`catch` instead of `try`/`catch` because
              // the resolution/rejection occurs out of band. To be more
              // specific, the promise will be fulfilled while the `while` loop
              // below is running. This means that if we did not attach `catch`
              // to the promise, Node would complain that the promise had a
              // unhandled rejection. So we attach `catch` to capture the
              // rejection and we also attach `then` to capture the resolution
              // and check them after the loop ends.

              let capturedResolutionValue;
              let capturedRejectionValue;
              makeRpcCall(request)
                .then((resolutionValue) => {
                  capturedResolutionValue = resolutionValue;
                })
                .catch((rejectionValue) => {
                  capturedRejectionValue = rejectionValue;
                });

              // ESLint complains that capturedResolutionValue and
              // capturedRejectionValue don't change during the loop, but thanks
              // to the magic of asynchronicity, they do
              while (
                /* eslint-disable-next-line no-unmodified-loop-condition */
                capturedResolutionValue === undefined &&
                /* eslint-disable-next-line no-unmodified-loop-condition */
                capturedRejectionValue === undefined
              ) {
                clock.runAll();
                await new Promise((resolve) =>
                  originalSetTimeout(
                    resolve,
                    TIME_TO_WAIT_FOR_NEXT_INFURA_RETRY,
                  ),
                );
              }

              if (capturedRejectionValue !== undefined) {
                return Promise.reject(capturedRejectionValue);
              }
              return Promise.resolve(capturedResolutionValue);
            },
          );

          expect(result).toStrictEqual('the result');
        });
      });

      it(`causes a request to fail with a custom error if an "${errorMessagePrefix}" error is thrown while making the request to Infura 5 times in a row`, async () => {
        await mockingInfuraCommunications(async (comms) => {
          const request = { method };

          // The first time a block-cacheable request is made, the latest block
          // number is retrieved through the block tracker first. It doesn't
          // matter what this is — it's just used as a cache key.
          comms.mockNextBlockTrackerRequest();
          comms.mockInfuraRpcCall({
            request,
            error: `${errorMessagePrefix}: Some message`,
            times: 5,
          });
          const promiseForResult = withInfuraClient(
            async ({ makeRpcCall, clock }) => {
              // Note that we have to manually capture the value that the
              // promise that `makeRpcCall` returns when it resolves or is
              // rejected using `then`/`catch` instead of `try`/`catch` because
              // the resolution/rejection occurs out of band. To be more
              // specific, the promise will be fulfilled while the `while` loop
              // below is running. This means that if we did not attach `catch`
              // to the promise, Node would complain that the promise had a
              // unhandled rejection. So we attach `catch` to capture the
              // rejection and we also attach `then` to capture the resolution
              // and check them after the loop ends.

              let capturedResolutionValue;
              let capturedRejectionValue;
              makeRpcCall(request)
                .then((resolutionValue) => {
                  capturedResolutionValue = resolutionValue;
                })
                .catch((rejectionValue) => {
                  capturedRejectionValue = rejectionValue;
                });

              // ESLint complains that capturedResolutionValue and
              // capturedRejectionValue don't change during the loop, but thanks
              // to the magic of asynchronicity, they do
              while (
                /* eslint-disable-next-line no-unmodified-loop-condition */
                capturedResolutionValue === undefined &&
                /* eslint-disable-next-line no-unmodified-loop-condition */
                capturedRejectionValue === undefined
              ) {
                clock.runAll();
                await new Promise((resolve) =>
                  originalSetTimeout(
                    resolve,
                    TIME_TO_WAIT_FOR_NEXT_INFURA_RETRY,
                  ),
                );
              }

              if (capturedRejectionValue !== undefined) {
                return Promise.reject(capturedRejectionValue);
              }
              return Promise.resolve(capturedResolutionValue);
            },
          );

          await expect(promiseForResult).rejects.toThrow(
            new RegExp(
              `^InfuraProvider - cannot complete request\\. All retries exhausted\\..+${errorMessagePrefix}: Some message`,
              'su',
            ),
          );
        });
      });
    });
  });
}

/**
 * Defines tests which exercise the behavior exhibited by an RPC method that
 * use `blockHash` in the response data to determine whether the response is
 * cacheable.
 */
/* eslint-disable-next-line jest/no-export */
export function testsForRpcMethodsThatCheckForBlockHashInResponse(method) {
  describe('behaves like an RPC method that checks for `blockHash` in the response', () => {
    it('does not hit Infura more than once for identical requests and it has a valid blockHash', async () => {
      const requests = [{ method }, { method }];
      const mockResults = [{ blockHash: '0x100' }, { blockHash: '0x200' }];

      await mockingInfuraCommunications(async (comms) => {
        // The first time a block-cacheable request is made, the latest block
        // number is retrieved through the block tracker first. It doesn't
        // matter what this is — it's just used as a cache key.
        comms.mockNextBlockTrackerRequest();
        comms.mockInfuraRpcCall({
          request: requests[0],
          response: { result: mockResults[0] },
        });

        const results = await withInfuraClient(({ makeRpcCallsInSeries }) =>
          makeRpcCallsInSeries(requests),
        );

        expect(results).toStrictEqual([mockResults[0], mockResults[0]]);
      });
    });

    it('hits Infura and does not reuse the result of a previous request if the latest block number was updated since', async () => {
      const requests = [{ method }, { method }];
      const mockResults = [{ blockHash: '0x100' }, { blockHash: '0x200' }];

      await mockingInfuraCommunications(async (comms) => {
        // Note that we have to mock these requests in a specific order. The
        // first block tracker request occurs because of the first RPC
        // request. The second block tracker request, however, does not occur
        // because of the second RPC request, but rather because we call
        // `clock.runAll()` below.
        comms.mockNextBlockTrackerRequest({ blockNumber: '0x1' });
        comms.mockInfuraRpcCall({
          request: requests[0],
          response: { result: mockResults[0] },
        });
        comms.mockNextBlockTrackerRequest({ blockNumber: '0x2' });
        comms.mockInfuraRpcCall({
          request: requests[1],
          response: { result: mockResults[1] },
        });

        const results = await withInfuraClient(async (client) => {
          const firstResult = await client.makeRpcCall(requests[0]);
          // Proceed to the next iteration of the block tracker so that a new
          // block is fetched and the current block is updated
          client.clock.runAll();
          const secondResult = await client.makeRpcCall(requests[1]);
          return [firstResult, secondResult];
        });

        expect(results).toStrictEqual(mockResults);
      });
    });

    it.each([null, undefined, '\u003cnil\u003e'])(
      'does not reuse the result of a previous request if it was `%s`',
      async (emptyValue) => {
        const requests = [{ method }, { method }];
        const mockResults = [emptyValue, { blockHash: '0x100' }];

        await mockingInfuraCommunications(async (comms) => {
          // The first time a block-cacheable request is made, the latest block
          // number is retrieved through the block tracker first. It doesn't
          // matter what this is — it's just used as a cache key.
          comms.mockNextBlockTrackerRequest();
          comms.mockInfuraRpcCall({
            request: requests[0],
            response: { result: mockResults[0] },
          });
          comms.mockInfuraRpcCall({
            request: requests[1],
            response: { result: mockResults[1] },
          });

          const results = await withInfuraClient(({ makeRpcCallsInSeries }) =>
            makeRpcCallsInSeries(requests),
          );

          expect(results).toStrictEqual(mockResults);
        });
      },
    );

    it('does not reuse the result of a previous request if result.blockHash was null', async () => {
      const requests = [{ method }, { method }];
      const mockResults = [
        { blockHash: null, extra: 'some value' },
        { blockHash: '0x100', extra: 'some other value' },
      ];

      await mockingInfuraCommunications(async (comms) => {
        // The first time a block-cacheable request is made, the latest block
        // number is retrieved through the block tracker first. It doesn't
        // matter what this is — it's just used as a cache key.
        comms.mockNextBlockTrackerRequest();
        comms.mockInfuraRpcCall({
          request: requests[0],
          response: { result: mockResults[0] },
        });
        comms.mockInfuraRpcCall({
          request: requests[1],
          response: { result: mockResults[1] },
        });

        const results = await withInfuraClient(({ makeRpcCallsInSeries }) =>
          makeRpcCallsInSeries(requests),
        );

        expect(results).toStrictEqual(mockResults);
      });
    });

    it('does not reuse the result of a previous request if result.blockHash was undefined', async () => {
      const requests = [{ method }, { method }];
      const mockResults = [
        { extra: 'some value' },
        { blockHash: '0x100', extra: 'some other value' },
      ];

      await mockingInfuraCommunications(async (comms) => {
        // The first time a block-cacheable request is made, the latest block
        // number is retrieved through the block tracker first. It doesn't
        // matter what this is — it's just used as a cache key.
        comms.mockNextBlockTrackerRequest();
        comms.mockInfuraRpcCall({
          request: requests[0],
          response: { result: mockResults[0] },
        });
        comms.mockInfuraRpcCall({
          request: requests[1],
          response: { result: mockResults[1] },
        });

        const results = await withInfuraClient(({ makeRpcCallsInSeries }) =>
          makeRpcCallsInSeries(requests),
        );

        expect(results).toStrictEqual(mockResults);
      });
    });

    it('does not reuse the result of a previous request if result.blockHash was "0x0000000000000000000000000000000000000000000000000000000000000000"', async () => {
      const requests = [{ method }, { method }];
      const mockResults = [
        {
          blockHash:
            '0x0000000000000000000000000000000000000000000000000000000000000000',
          extra: 'some value',
        },
        { blockHash: '0x100', extra: 'some other value' },
      ];

      await mockingInfuraCommunications(async (comms) => {
        // The first time a block-cacheable request is made, the latest block
        // number is retrieved through the block tracker first. It doesn't
        // matter what this is — it's just used as a cache key.
        comms.mockNextBlockTrackerRequest();
        comms.mockInfuraRpcCall({
          request: requests[0],
          response: { result: mockResults[0] },
        });
        comms.mockInfuraRpcCall({
          request: requests[1],
          response: { result: mockResults[1] },
        });

        const results = await withInfuraClient(({ makeRpcCallsInSeries }) =>
          makeRpcCallsInSeries(requests),
        );

        expect(results).toStrictEqual(mockResults);
      });
    });
  });
}

/**
 * Defines tests which exercise the behavior exhibited by an RPC method that
 * supports multiple params (which affect how the method is cached).
 */
/* eslint-disable-next-line jest/no-export */
export function testsForRpcMethodThatSupportsMultipleParams(
  method,
  { numberOfParams },
) {
  const blockParamIndex = numberOfParams;

  describe.each([
    ['given no block tag', 'none'],
    ['given a block tag of "latest"', 'latest', 'latest'],
  ])('%s', (_desc, blockParamType, blockParam) => {
    const params =
      blockParamType === 'none'
        ? buildMockParamsWithoutBlockParamAt(blockParamIndex)
        : buildMockParamsWithBlockParamAt(blockParamIndex, blockParam);

    it('does not hit Infura more than once for identical requests', async () => {
      const requests = [
        { method, params },
        { method, params },
      ];
      const mockResults = ['first result', 'second result'];

      await mockingInfuraCommunications(async (comms) => {
        // The first time a block-cacheable request is made, the block-cache
        // middleware will request the latest block number through the block
        // tracker to determine the cache key. Later, the block-ref
        // middleware will request the latest block number again to resolve
        // the value of "latest", but the block number is cached once made,
        // so we only need to mock the request once.
        comms.mockNextBlockTrackerRequest({ blockNumber: '0x100' });
        // The block-ref middleware will make the request as specified
        // except that the block param is replaced with the latest block
        // number.
        comms.mockInfuraRpcCall({
          request: buildRequestWithReplacedBlockParam(
            requests[0],
            blockParamIndex,
            '0x100',
          ),
          response: { result: mockResults[0] },
        });
        // Note that the block-ref middleware will still allow the original
        // request to go through.
        comms.mockInfuraRpcCall({
          request: requests[0],
          response: { result: mockResults[0] },
        });

        const results = await withInfuraClient(({ makeRpcCallsInSeries }) =>
          makeRpcCallsInSeries(requests),
        );

        expect(results).toStrictEqual([mockResults[0], mockResults[0]]);
      });
    });

    it('hits Infura and does not reuse the result of a previous request if the latest block number was updated since', async () => {
      const requests = [
        { method, params },
        { method, params },
      ];
      const mockResults = ['first result', 'second result'];

      await mockingInfuraCommunications(async (comms) => {
        // Note that we have to mock these requests in a specific order.
        // The first block tracker request occurs because of the first RPC
        // request. The second block tracker request, however, does not
        // occur because of the second RPC request, but rather because we
        // call `clock.runAll()` below.
        comms.mockNextBlockTrackerRequest({ blockNumber: '0x100' });
        // The block-ref middleware will make the request as specified
        // except that the block param is replaced with the latest block
        // number.
        comms.mockInfuraRpcCall({
          request: buildRequestWithReplacedBlockParam(
            requests[0],
            blockParamIndex,
            '0x100',
          ),
          response: { result: mockResults[0] },
        });
        // Note that the block-ref middleware will still allow the original
        // request to go through.
        comms.mockInfuraRpcCall({
          request: requests[0],
          response: { result: mockResults[0] },
        });
        comms.mockNextBlockTrackerRequest({ blockNumber: '0x200' });
        comms.mockInfuraRpcCall({
          request: requests[1],
          response: { result: mockResults[1] },
        });
        // The previous two requests will happen again, with a different block
        // number, in the same order.
        comms.mockInfuraRpcCall({
          request: buildRequestWithReplacedBlockParam(
            requests[0],
            blockParamIndex,
            '0x200',
          ),
          response: { result: mockResults[1] },
        });
        comms.mockInfuraRpcCall({
          request: requests[0],
          response: { result: mockResults[1] },
        });

        const results = await withInfuraClient(async (client) => {
          const firstResult = await client.makeRpcCall(requests[0]);
          // Proceed to the next iteration of the block tracker so that a
          // new block is fetched and the current block is updated
          client.clock.runAll();
          const secondResult = await client.makeRpcCall(requests[1]);
          return [firstResult, secondResult];
        });

        expect(results).toStrictEqual(mockResults);
      });
    });

    it.each([null, undefined, '\u003cnil\u003e'])(
      'does not reuse the result of a previous request if it was `%s`',
      async (emptyValue) => {
        const requests = [
          { method, params },
          { method, params },
        ];
        const mockResults = [emptyValue, 'some result'];

        await mockingInfuraCommunications(async (comms) => {
          // The first time a block-cacheable request is made, the
          // block-cache middleware will request the latest block number
          // through the block tracker to determine the cache key. Later,
          // the block-ref middleware will request the latest block number
          // again to resolve the value of "latest", but the block number is
          // cached once made, so we only need to mock the request once.
          comms.mockNextBlockTrackerRequest({ blockNumber: '0x100' });
          // The block-ref middleware will make the request as specified
          // except that the block param is replaced with the latest block
          // number.
          comms.mockInfuraRpcCall({
            request: buildRequestWithReplacedBlockParam(
              requests[0],
              blockParamIndex,
              '0x100',
            ),
            response: { result: mockResults[0] },
          });
          // Note that the block-ref middleware will still allow the original
          // request to go through.
          comms.mockInfuraRpcCall({
            request: requests[0],
            response: { result: mockResults[0] },
          });
          // The previous two requests will happen again, in the same order.
          comms.mockInfuraRpcCall({
            request: buildRequestWithReplacedBlockParam(
              requests[0],
              blockParamIndex,
              '0x100',
            ),
            response: { result: mockResults[1] },
          });
          comms.mockInfuraRpcCall({
            request: requests[0],
            response: { result: mockResults[1] },
          });

          const results = await withInfuraClient(({ makeRpcCallsInSeries }) =>
            makeRpcCallsInSeries(requests),
          );

          expect(results).toStrictEqual(mockResults);
        });
      },
    );

    it('queues requests while a previous identical call is still pending, then runs the queue when it finishes, reusing the result from the first request', async () => {
      const requests = [{ method }, { method }, { method }];
      const mockResults = ['first result', 'second result', 'third result'];

      await mockingInfuraCommunications(async (comms) => {
        // The first time a block-cacheable request is made, the
        // block-cache middleware will request the latest block number
        // through the block tracker to determine the cache key. Later,
        // the block-ref middleware will request the latest block number
        // again to resolve the value of "latest", but the block number is
        // cached once made, so we only need to mock the request once.
        comms.mockNextBlockTrackerRequest({ blockNumber: '0x100' });
        // The block-ref middleware will make the request as specified
        // except that the block param is replaced with the latest block
        // number.
        comms.mockInfuraRpcCall({
          request: buildRequestWithReplacedBlockParam(
            requests[0],
            blockParamIndex,
            '0x100',
          ),
          response: { result: mockResults[0] },
        });
        // This is the original request as below, which the block-ref
        // middleware will allow through, except that we delay it.
        comms.mockInfuraRpcCall({
          request: requests[0],
          response: { result: mockResults[0] },
          delay: 100,
        });
        // The previous two requests will happen again, in the same order.
        comms.mockInfuraRpcCall({
          request: buildRequestWithReplacedBlockParam(
            requests[1],
            blockParamIndex,
            '0x100',
          ),
          response: { result: mockResults[1] },
        });
        comms.mockInfuraRpcCall({
          request: requests[1],
          response: { result: mockResults[1] },
        });
        comms.mockInfuraRpcCall({
          request: buildRequestWithReplacedBlockParam(
            requests[2],
            blockParamIndex,
            '0x100',
          ),
          response: { result: mockResults[2] },
        });
        comms.mockInfuraRpcCall({
          request: requests[2],
          response: { result: mockResults[2] },
        });

        const results = await withInfuraClient(async (client) => {
          const resultPromises = [
            client.makeRpcCall(requests[0]),
            client.makeRpcCall(requests[1]),
            client.makeRpcCall(requests[2]),
          ];
          const firstResult = await resultPromises[0];
          // The inflight cache middleware uses setTimeout to run the
          // handlers, so run them now
          client.clock.runAll();
          const remainingResults = await Promise.all(resultPromises.slice(1));
          return [firstResult, ...remainingResults];
        });

        expect(results).toStrictEqual([
          mockResults[0],
          mockResults[0],
          mockResults[0],
        ]);
      });
    });

    if (blockParamType === 'none') {
      it('throws a custom error if the request to Infura returns a 405 response', async () => {
        await mockingInfuraCommunications(async (comms) => {
          const request = { method };

          // The first time a block-cacheable request is made, the
          // block-cache middleware will request the latest block number
          // through the block tracker to determine the cache key. Later,
          // the block-ref middleware will request the latest block number
          // again to resolve the value of "latest", but the block number is
          // cached once made, so we only need to mock the request once.
          comms.mockNextBlockTrackerRequest({ blockNumber: '0x100' });
          // The block-ref middleware will make the request as specified
          // except that the block param is replaced with the latest block
          // number.
          //
          // Note, however, that the block-ref middleware doesn't run the
          // original request, as it fails before it gets to that point, so
          // there is no need to mock the request again.
          comms.mockInfuraRpcCall({
            request: buildRequestWithReplacedBlockParam(
              request,
              blockParamIndex,
              '0x100',
            ),
            response: {
              httpStatus: 405,
            },
          });
          const promiseForResult = withInfuraClient(async ({ makeRpcCall }) =>
            makeRpcCall(request),
          );

          await expect(promiseForResult).rejects.toThrow(
            'The method does not exist / is not available',
          );
        });
      });

      it('throws a custom error if the request to Infura returns a 429 response', async () => {
        await mockingInfuraCommunications(async (comms) => {
          const request = { method };

          // The first time a block-cacheable request is made, the
          // block-cache middleware will request the latest block number
          // through the block tracker to determine the cache key. Later,
          // the block-ref middleware will request the latest block number
          // again to resolve the value of "latest", but the block number is
          // cached once made, so we only need to mock the request once.
          comms.mockNextBlockTrackerRequest({ blockNumber: '0x100' });
          // The block-ref middleware will make the request as specified
          // except that the block param is replaced with the latest block
          // number.
          //
          // Note, however, that the block-ref middleware doesn't run the
          // original request, as it fails before it gets to that point, so
          // there is no need to mock the request again.
          comms.mockInfuraRpcCall({
            request: buildRequestWithReplacedBlockParam(
              request,
              blockParamIndex,
              '0x100',
            ),
            response: {
              httpStatus: 429,
            },
          });
          const promiseForResult = withInfuraClient(async ({ makeRpcCall }) =>
            makeRpcCall(request),
          );

          await expect(promiseForResult).rejects.toThrow(
            'Request is being rate limited',
          );
        });
      });

      it('throws a custom error if the request to Infura returns a response that is not 405, 429, 503, or 504', async () => {
        await mockingInfuraCommunications(async (comms) => {
          const request = { method };

          // The first time a block-cacheable request is made, the
          // block-cache middleware will request the latest block number
          // through the block tracker to determine the cache key. Later,
          // the block-ref middleware will request the latest block number
          // again to resolve the value of "latest", but the block number is
          // cached once made, so we only need to mock the request once.
          comms.mockNextBlockTrackerRequest({ blockNumber: '0x100' });
          // The block-ref middleware will make the request as specified
          // except that the block param is replaced with the latest block
          // number.
          //
          // Note, however, that the block-ref middleware doesn't run the
          // original request, as it fails before it gets to that point, so
          // there is no need to mock the request again.
          comms.mockInfuraRpcCall({
            request: buildRequestWithReplacedBlockParam(
              request,
              blockParamIndex,
              '0x100',
            ),
            response: {
              id: 12345,
              jsonrpc: '2.0',
              error: 'some error',
              httpStatus: 420,
            },
          });
          const promiseForResult = withInfuraClient(async ({ makeRpcCall }) =>
            makeRpcCall(request),
          );

          await expect(promiseForResult).rejects.toThrow(
            '{"id":12345,"jsonrpc":"2.0","error":"some error"}',
          );
        });
      });

      [503, 504].forEach((httpStatus) => {
        it(`retries the request to Infura up to 5 times if it returns a ${httpStatus} response, returning the successful result if there is one on the 5th try`, async () => {
          await mockingInfuraCommunications(async (comms) => {
            const request = { method };

            // The first time a block-cacheable request is made, the
            // block-cache middleware will request the latest block number
            // through the block tracker to determine the cache key. Later,
            // the block-ref middleware will request the latest block number
            // again to resolve the value of "latest", but the block number is
            // cached once made, so we only need to mock the request once.
            comms.mockNextBlockTrackerRequest({ blockNumber: '0x100' });
            // The block-ref middleware will make the request as specified
            // except that the block param is replaced with the latest block
            // number.
            //
            // Here we have the request fail for the first 4 tries, then succeed
            // on the 5th try.
            comms.mockInfuraRpcCall({
              request: buildRequestWithReplacedBlockParam(
                request,
                blockParamIndex,
                '0x100',
              ),
              response: {
                error: 'some error',
                httpStatus,
              },
              times: 4,
            });
            comms.mockInfuraRpcCall({
              request: buildRequestWithReplacedBlockParam(
                request,
                blockParamIndex,
                '0x100',
              ),
              response: {
                result: 'the result',
                httpStatus: 200,
              },
            });
            // Note that the block-ref middleware will still allow the original
            // request to go through.
            comms.mockInfuraRpcCall({
              request,
              response: {
                result: 'the result',
                httpStatus: 200,
              },
            });
            const result = await withInfuraClient(
              async ({ makeRpcCall, clock }) => {
                // Note that we have to manually capture the value that the
                // promise that `makeRpcCall` returns when it resolves or is
                // rejected using `then`/`catch` instead of `try`/`catch`
                // because the resolution/rejection occurs out of band. To be
                // more specific, the promise will be fulfilled while the
                // `while` loop below is running. This means that if we did not
                // attach `catch` to the promise, Node would complain that the
                // promise had a unhandled rejection. So we attach `catch` to
                // capture the rejection and we also attach `then` to capture
                // the resolution and check them after the loop ends.

                let capturedResolutionValue;
                let capturedRejectionValue;
                makeRpcCall(request)
                  .then((resolutionValue) => {
                    capturedResolutionValue = resolutionValue;
                  })
                  .catch((rejectionValue) => {
                    capturedRejectionValue = rejectionValue;
                  });

                while (
                  /* eslint-disable-next-line no-unmodified-loop-condition */
                  capturedResolutionValue === undefined &&
                  /* eslint-disable-next-line no-unmodified-loop-condition */
                  capturedRejectionValue === undefined
                ) {
                  clock.runAll();
                  await new Promise((resolve) =>
                    originalSetTimeout(
                      resolve,
                      TIME_TO_WAIT_FOR_NEXT_INFURA_RETRY,
                    ),
                  );
                }

                if (capturedRejectionValue !== undefined) {
                  return Promise.reject(capturedRejectionValue);
                }
                return Promise.resolve(capturedResolutionValue);
              },
            );

            expect(result).toStrictEqual('the result');
          });
        });

        it(`causes a request to fail with a custom error if the request to Infura returns a ${httpStatus} response 5 times in a row`, async () => {
          await mockingInfuraCommunications(async (comms) => {
            const request = { method };

            // The first time a block-cacheable request is made, the
            // block-cache middleware will request the latest block number
            // through the block tracker to determine the cache key. Later,
            // the block-ref middleware will request the latest block number
            // again to resolve the value of "latest", but the block number is
            // cached once made, so we only need to mock the request once.
            comms.mockNextBlockTrackerRequest({ blockNumber: '0x100' });
            // The block-ref middleware will make the request as specified
            // except that the block param is replaced with the latest block
            // number.
            //
            // Note, however, that the block-ref middleware doesn't run the
            // original request, as it fails before it gets to that point, so
            // there is no need to mock the request again.
            comms.mockInfuraRpcCall({
              request: buildRequestWithReplacedBlockParam(
                request,
                blockParamIndex,
                '0x100',
              ),
              response: {
                error: 'Some error',
                httpStatus,
              },
              times: 5,
            });
            const promiseForResult = withInfuraClient(
              async ({ makeRpcCall, clock }) => {
                // Note that we have to manually capture the value that the
                // promise that `makeRpcCall` returns when it resolves or is
                // rejected using `then`/`catch` instead of `try`/`catch`
                // because the resolution/rejection occurs out of band. To be
                // more specific, the promise will be fulfilled while the
                // `while` loop below is running. This means that if we did not
                // attach `catch` to the promise, Node would complain that the
                // promise had a unhandled rejection. So we attach `catch` to
                // capture the rejection and we also attach `then` to capture
                // the resolution and check them after the loop ends.

                let capturedResolutionValue;
                let capturedRejectionValue;
                makeRpcCall(request)
                  .then((resolutionValue) => {
                    capturedResolutionValue = resolutionValue;
                  })
                  .catch((rejectionValue) => {
                    capturedRejectionValue = rejectionValue;
                  });

                while (
                  /* eslint-disable-next-line no-unmodified-loop-condition */
                  capturedResolutionValue === undefined &&
                  /* eslint-disable-next-line no-unmodified-loop-condition */
                  capturedRejectionValue === undefined
                ) {
                  clock.runAll();
                  await new Promise((resolve) =>
                    originalSetTimeout(
                      resolve,
                      TIME_TO_WAIT_FOR_NEXT_INFURA_RETRY,
                    ),
                  );
                }

                if (capturedRejectionValue !== undefined) {
                  return Promise.reject(capturedRejectionValue);
                }
                return Promise.resolve(capturedResolutionValue);
              },
            );

            await expect(promiseForResult).rejects.toThrow(
              /^InfuraProvider - cannot complete request\. All retries exhausted\..+Gateway timeout/su,
            );
          });
        });
      });

      ['ETIMEDOUT', 'ECONNRESET', 'SyntaxError'].forEach(
        (errorMessagePrefix) => {
          it(`retries the request to Infura up to 5 times if an "${errorMessagePrefix}" error is thrown while making the request, returning the successful result if there is one on the 5th try`, async () => {
            await mockingInfuraCommunications(async (comms) => {
              const request = { method };

              // The first time a block-cacheable request is made, the
              // block-cache middleware will request the latest block number
              // through the block tracker to determine the cache key. Later,
              // the block-ref middleware will request the latest block number
              // again to resolve the value of "latest", but the block number is
              // cached once made, so we only need to mock the request once.
              comms.mockNextBlockTrackerRequest({ blockNumber: '0x100' });
              // The block-ref middleware will make the request as specified
              // except that the block param is replaced with the latest block
              // number.
              //
              // Here we have the request fail for the first 4 tries, then
              // succeed on the 5th try.
              comms.mockInfuraRpcCall({
                request: buildRequestWithReplacedBlockParam(
                  request,
                  blockParamIndex,
                  '0x100',
                ),
                error: `${errorMessagePrefix}: Some message`,
                times: 4,
              });
              comms.mockInfuraRpcCall({
                request: buildRequestWithReplacedBlockParam(
                  request,
                  blockParamIndex,
                  '0x100',
                ),
                response: {
                  result: 'the result',
                  httpStatus: 200,
                },
              });
              // Note that the block-ref middleware will still allow the
              // original request to go through.
              comms.mockInfuraRpcCall({
                request,
                response: {
                  result: 'the result',
                  httpStatus: 200,
                },
              });
              const result = await withInfuraClient(
                async ({ makeRpcCall, clock }) => {
                  // Note that we have to manually capture the value that the
                  // promise that `makeRpcCall` returns when it resolves or is
                  // rejected using `then`/`catch` instead of `try`/`catch`
                  // because the resolution/rejection occurs out of band. To be
                  // more specific, the promise will be fulfilled while the
                  // `while` loop below is running. This means that if we did
                  // not attach `catch` to the promise, Node would complain that
                  // the promise had a unhandled rejection. So we attach `catch`
                  // to capture the rejection and we also attach `then` to
                  // capture the resolution and check them after the loop ends.

                  let capturedResolutionValue;
                  let capturedRejectionValue;
                  makeRpcCall(request)
                    .then((resolutionValue) => {
                      capturedResolutionValue = resolutionValue;
                    })
                    .catch((rejectionValue) => {
                      capturedRejectionValue = rejectionValue;
                    });

                  while (
                    /* eslint-disable-next-line no-unmodified-loop-condition */
                    capturedResolutionValue === undefined &&
                    /* eslint-disable-next-line no-unmodified-loop-condition */
                    capturedRejectionValue === undefined
                  ) {
                    clock.runAll();
                    await new Promise((resolve) =>
                      originalSetTimeout(
                        resolve,
                        TIME_TO_WAIT_FOR_NEXT_INFURA_RETRY,
                      ),
                    );
                  }

                  if (capturedRejectionValue !== undefined) {
                    return Promise.reject(capturedRejectionValue);
                  }
                  return Promise.resolve(capturedResolutionValue);
                },
              );

              expect(result).toStrictEqual('the result');
            });
          }, 5000);

          it(`causes a request to fail with a custom error if an "${errorMessagePrefix}" error is thrown while making the request to Infura 5 times in a row`, async () => {
            await mockingInfuraCommunications(async (comms) => {
              const request = { method };

              // The first time a block-cacheable request is made, the
              // block-cache middleware will request the latest block number
              // through the block tracker to determine the cache key. Later,
              // the block-ref middleware will request the latest block number
              // again to resolve the value of "latest", but the block number is
              // cached once made, so we only need to mock the request once.
              comms.mockNextBlockTrackerRequest({ blockNumber: '0x100' });
              // The block-ref middleware will make the request as specified
              // except that the block param is replaced with the latest block
              // number.
              //
              // Note, however, that the block-ref middleware doesn't run the
              // original request, as it fails before it gets to that point, so
              // there is no need to mock the request again.
              comms.mockInfuraRpcCall({
                request: buildRequestWithReplacedBlockParam(
                  request,
                  blockParamIndex,
                  '0x100',
                ),
                error: `${errorMessagePrefix}: Some message`,
                times: 5,
              });
              const promiseForResult = withInfuraClient(
                async ({ makeRpcCall, clock }) => {
                  // Note that we have to manually capture the value that the
                  // promise that `makeRpcCall` returns when it resolves or is
                  // rejected using `then`/`catch` instead of `try`/`catch`
                  // because the resolution/rejection occurs out of band. To be
                  // more specific, the promise will be fulfilled while the
                  // `while` loop below is running. This means that if we did
                  // not attach `catch` to the promise, Node would complain that
                  // the promise had a unhandled rejection. So we attach `catch`
                  // to capture the rejection and we also attach `then` to
                  // capture the resolution and check them after the loop ends.

                  let capturedResolutionValue;
                  let capturedRejectionValue;
                  makeRpcCall(request)
                    .then((resolutionValue) => {
                      capturedResolutionValue = resolutionValue;
                    })
                    .catch((rejectionValue) => {
                      capturedRejectionValue = rejectionValue;
                    });

                  while (
                    /* eslint-disable-next-line no-unmodified-loop-condition */
                    capturedResolutionValue === undefined &&
                    /* eslint-disable-next-line no-unmodified-loop-condition */
                    capturedRejectionValue === undefined
                  ) {
                    clock.runAll();
                    await new Promise((resolve) =>
                      originalSetTimeout(
                        resolve,
                        TIME_TO_WAIT_FOR_NEXT_INFURA_RETRY,
                      ),
                    );
                  }

                  if (capturedRejectionValue !== undefined) {
                    return Promise.reject(capturedRejectionValue);
                  }
                  return Promise.resolve(capturedResolutionValue);
                },
              );

              await expect(promiseForResult).rejects.toThrow(
                new RegExp(
                  `^InfuraProvider - cannot complete request\\. All retries exhausted\\..+${errorMessagePrefix}: Some message`,
                  'su',
                ),
              );
            });
          });
        },
      );
    }
  });

  describe.each([
    ['given a block tag of "earliest"', 'earliest', 'earliest'],
    ['given a block number', 'block number', '0x100'],
  ])('%s', (_desc, blockParamType, blockParam) => {
    const params = buildMockParamsWithBlockParamAt(blockParamIndex, blockParam);

    it('does not hit Infura more than once for identical requests', async () => {
      const requests = [
        { method, params },
        { method, params },
      ];
      const mockResults = ['first result', 'second result'];

      await mockingInfuraCommunications(async (comms) => {
        // The first time a block-cacheable request is made, the block-cache
        // middleware will request the latest block number through the block
        // tracker to determine the cache key. This block number doesn't
        // matter.
        comms.mockNextBlockTrackerRequest();
        comms.mockInfuraRpcCall({
          request: requests[0],
          response: { result: mockResults[0] },
        });

        const results = await withInfuraClient(({ makeRpcCallsInSeries }) =>
          makeRpcCallsInSeries(requests),
        );

        expect(results).toStrictEqual([mockResults[0], mockResults[0]]);
      });
    });

    it('reuses the result of a previous request even if the latest block number was updated since', async () => {
      const requests = [
        { method, params },
        { method, params },
      ];
      const mockResults = ['first result', 'second result'];

      await mockingInfuraCommunications(async (comms) => {
        // Note that we have to mock these requests in a specific order. The
        // first block tracker request occurs because of the first RPC
        // request. The second block tracker request, however, does not
        // occur because of the second RPC request, but rather because we
        // call `clock.runAll()` below.
        comms.mockNextBlockTrackerRequest({ blockNumber: '0x1' });
        comms.mockInfuraRpcCall({
          request: requests[0],
          response: { result: mockResults[0] },
        });
        comms.mockNextBlockTrackerRequest({ blockNumber: '0x2' });
        comms.mockInfuraRpcCall({
          request: requests[1],
          response: { result: mockResults[1] },
        });

        const results = await withInfuraClient(async (client) => {
          const firstResult = await client.makeRpcCall(requests[0]);
          // Proceed to the next iteration of the block tracker so that a
          // new block is fetched and the current block is updated
          client.clock.runAll();
          const secondResult = await client.makeRpcCall(requests[1]);
          return [firstResult, secondResult];
        });

        expect(results).toStrictEqual([mockResults[0], mockResults[0]]);
      });
    });

    it.each([null, undefined, '\u003cnil\u003e'])(
      'does not reuse the result of a previous request if it was `%s`',
      async (emptyValue) => {
        const requests = [
          { method, params },
          { method, params },
        ];
        const mockResults = [emptyValue, 'some result'];

        await mockingInfuraCommunications(async (comms) => {
          // The first time a block-cacheable request is made, the latest block
          // number is retrieved through the block tracker first. It doesn't
          // matter what this is — it's just used as a cache key.
          comms.mockNextBlockTrackerRequest();
          comms.mockInfuraRpcCall({
            request: requests[0],
            response: { result: mockResults[0] },
          });
          comms.mockInfuraRpcCall({
            request: requests[1],
            response: { result: mockResults[1] },
          });

          const results = await withInfuraClient(({ makeRpcCallsInSeries }) =>
            makeRpcCallsInSeries(requests),
          );

          expect(results).toStrictEqual(mockResults);
        });
      },
    );

    if (blockParamType === 'earliest') {
      it('treats "0x00" as a synonym for "earliest"', async () => {
        const requests = [
          {
            method,
            params: buildMockParamsWithBlockParamAt(
              blockParamIndex,
              blockParam,
            ),
          },
          {
            method,
            params: buildMockParamsWithBlockParamAt(blockParamIndex, '0x00'),
          },
        ];
        const mockResults = ['first result', 'second result'];

        await mockingInfuraCommunications(async (comms) => {
          // The first time a block-cacheable request is made, the latest
          // block number is retrieved through the block tracker first. It
          // doesn't matter what this is — it's just used as a cache key.
          comms.mockNextBlockTrackerRequest();
          comms.mockInfuraRpcCall({
            request: requests[0],
            response: { result: mockResults[0] },
          });

          const results = await withInfuraClient(({ makeRpcCallsInSeries }) =>
            makeRpcCallsInSeries(requests),
          );

          expect(results).toStrictEqual([mockResults[0], mockResults[0]]);
        });
      });
    }

    if (blockParamType === 'block number') {
      it('does not reuse the result of a previous request if it was made with different arguments than this one', async () => {
        await mockingInfuraCommunications(async (comms) => {
          const requests = [
            {
              method,
              params: buildMockParamsWithBlockParamAt(blockParamIndex, '0x100'),
            },
            {
              method,
              params: buildMockParamsWithBlockParamAt(blockParamIndex, '0x200'),
            },
          ];

          // The first time a block-cacheable request is made, the latest block
          // number is retrieved through the block tracker first. It doesn't
          // matter what this is — it's just used as a cache key.
          comms.mockNextBlockTrackerRequest();
          comms.mockInfuraRpcCall({
            request: requests[0],
            response: { result: 'first result' },
          });
          comms.mockInfuraRpcCall({
            request: requests[1],
            response: { result: 'second result' },
          });

          const results = await withInfuraClient(({ makeRpcCallsInSeries }) =>
            makeRpcCallsInSeries(requests),
          );

          expect(results).toStrictEqual(['first result', 'second result']);
        });
      });

      it('makes an additional request to Infura if the given block number matches the latest block number', async () => {
        await mockingInfuraCommunications(async (comms) => {
          const request = {
            method,
            params: buildMockParamsWithBlockParamAt(blockParamIndex, '0x100'),
          };

          // The first time a block-cacheable request is made, the latest
          // block number is retrieved through the block tracker first. This
          // also happens within the retry-on-empty middleware (although the
          // latest block is cached by now).
          comms.mockNextBlockTrackerRequest({ blockNumber: '0x100' });
          // The retry-on-empty middleware will make an explicit request.
          comms.mockInfuraRpcCall({
            request,
            response: { result: 'this result gets overwritten' },
          });
          // Note that the retry-on-empty middleware will still allow the
          // original request to go through.
          comms.mockInfuraRpcCall({
            request,
            response: { result: 'the actual result' },
          });

          const result = await withInfuraClient(({ makeRpcCall }) =>
            makeRpcCall(request),
          );

          expect(result).toStrictEqual('the actual result');
        });
      });

      it('makes an additional request to Infura if the given block number is less than the latest block number', async () => {
        await mockingInfuraCommunications(async (comms) => {
          const request = {
            method,
            params: buildMockParamsWithBlockParamAt(blockParamIndex, '0x50'),
          };

          // The first time a block-cacheable request is made, the latest
          // block number is retrieved through the block tracker first. This
          // also happens within the retry-on-empty middleware (although the
          // latest block is cached by now).
          comms.mockNextBlockTrackerRequest({ blockNumber: '0x100' });
          // The retry-on-empty middleware will make an explicit request.
          comms.mockInfuraRpcCall({
            request,
            response: { result: 'this result gets overwritten' },
          });
          // Note that the retry-on-empty middleware will still allow the
          // original request to go through.
          comms.mockInfuraRpcCall({
            request,
            response: { result: 'the actual result' },
          });

          const result = await withInfuraClient(({ makeRpcCall }) =>
            makeRpcCall(request),
          );

          expect(result).toStrictEqual('the actual result');
        });
      });
    }
  });

  describe('given a block tag of "pending"', () => {
    const params = buildMockParamsWithBlockParamAt(blockParamIndex, 'pending');

    it('hits Infura on all calls and does not cache anything', async () => {
      const requests = [
        { method, params },
        { method, params },
      ];
      const mockResults = ['first result', 'second result'];

      await mockingInfuraCommunications(async (comms) => {
        // The first time a block-cacheable request is made, the latest
        // block number is retrieved through the block tracker first. It
        // doesn't matter what this is — it's just used as a cache key.
        comms.mockNextBlockTrackerRequest();
        comms.mockInfuraRpcCall({
          request: requests[0],
          response: { result: mockResults[0] },
        });
        comms.mockInfuraRpcCall({
          request: requests[1],
          response: { result: mockResults[1] },
        });

        const results = await withInfuraClient(({ makeRpcCallsInSeries }) =>
          makeRpcCallsInSeries(requests),
        );

        expect(results).toStrictEqual(mockResults);
      });
    });
  });
}
