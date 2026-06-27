export interface UserRequest {
  userId: string;
}

export function userRoute(req: UserRequest): { id: string } {
  return { id: req.userId };
}
