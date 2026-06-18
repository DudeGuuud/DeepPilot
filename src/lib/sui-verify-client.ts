import { SuiGrpcClient } from "@mysten/sui/grpc";

import { clientGrpcUrls, clientNetwork, type ClientNetwork } from "./client-config";

export function createSuiVerifyClient(network: ClientNetwork = clientNetwork) {
  return new SuiGrpcClient({
    network,
    baseUrl: clientGrpcUrls[network]
  });
}
