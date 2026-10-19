export function applyEmailRecipientOverride(inputJson, recipients) {
  if (recipients.length === 0) {
    return inputJson;
  }

  if (inputJson && Object.hasOwn(inputJson, 'sendDetail')) {
    const detail = inputJson.sendDetail;
    const delivery = detail?.deliveryInfo;
    if (!detail || typeof detail !== 'object' || Array.isArray(detail) ||
        !delivery || typeof delivery !== 'object' || Array.isArray(delivery)) {
      throw new Error('Cannot override recipients: input JSON must contain a sendDetail.deliveryInfo object.');
    }
    if (recipients.length !== 1) {
      throw new Error('sendDetail email requires exactly one recipient address.');
    }
    return {
      ...inputJson,
      sendDetail: {
        ...detail,
        deliveryInfo: { ...delivery, contactValue: recipients[0] },
      },
    };
  }

  const billPrint = inputJson?.billPrint;
  const billDetails = billPrint?.billDetails;
  const cmElements = billDetails?.cmElements;
  if (
    !billPrint || typeof billPrint !== 'object' ||
    !billDetails || typeof billDetails !== 'object' ||
    !cmElements || typeof cmElements !== 'object'
  ) {
    throw new Error(
      'Cannot override recipients: input JSON must contain billPrint.billDetails.cmElements.',
    );
  }
  const eBill = cmElements.eBill && typeof cmElements.eBill === 'object' ? cmElements.eBill : {};

  return {
    ...inputJson,
    billPrint: {
      ...billPrint,
      billDetails: {
      ...billDetails,
        cmElements: {
          ...cmElements,
          eBill: {
            ...eBill,
            recipientEmails: recipients.map((email) => ({ email })),
          },
        },
      },
    },
  };
}
