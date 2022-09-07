import React, { useState } from 'react';
import Button from '../../../ui/button';
import ContractDetailsModal from './contract-details-modal';

export default {
  title: 'Components/App/Modals/ContractDetailsModal',
  id: __filename,
  argTypes: {
    onClosePopover: {
      action: 'Close Contract Details',
    },
    onOpenPopover: {
      action: 'Open Contract Details',
    },
    tokenSymbol: {
      control: {
        type: 'text',
      },
    },
    tokenAddress: {
      control: {
        type: 'text',
      },
    },
    siteImage: {
      control: {
        type: 'text',
      },
    },
    toAddress: {
      control: {
        type: 'text',
      },
    },
    origin: {
      control: {
        type: 'text',
      },
    },
    contractTitle: {
      control: {
        type: 'text',
      },
    },
    contractRequesting: {
      control: {
        type: 'text',
      },
    },
  },
  args: {
    tokenSymbol: 'DAI',
    tokenAddress: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
    siteImage: 'https://metamask.github.io/test-dapp/metamask-fox.svg',
    toAddress: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984',
    origin: 'https://metamask.github.io',
    contractTitle: 'Token contract',
    contractRequesting: 'Contract requesting spending cap',
  },
};

export const DefaultStory = (args) => {
  const [showContractDetails, setshowContractDetails] = useState(false);
  return (
    <>
      <Button
        onClick={() => {
          args.onOpenPopover();
          setshowContractDetails(true);
        }}
      >
        Verify contract details
      </Button>
      {showContractDetails && (
        <ContractDetailsModal
          onClose={() => {
            args.onClosePopover();
            setshowContractDetails(false);
          }}
          {...args}
        />
      )}
    </>
  );
};

DefaultStory.storyName = 'Default';
