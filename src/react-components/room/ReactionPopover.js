import React, { useCallback, useRef, useState } from "react";
import PropTypes from "prop-types";
import { ImageGridPopover } from "../popover/ImageGridPopover";
import { Popover } from "../popover/Popover";
import { ToolbarButton } from "../input/ToolbarButton";
import { ReactComponent as ReactionIcon } from "../icons/Reaction.svg";
import { ReactComponent as HandRaisedIcon } from "../icons/HandRaised.svg";
import { defineMessage, FormattedMessage, useIntl } from "react-intl";
import { Column } from "../layout/Column";
import { Row } from "../layout/Row";
import { HandRaisedButton } from "./ReactionButton";
import styles from "./ReactionPopover.scss";
import { Button } from "../input/Button";

const reactionPopoverTitle = defineMessage({
  id: "reaction-popover.title",
  defaultMessage: "React"
});

function ReactionPopoverContent({ items, presence, onToggleHandRaised, ...rest }) {
  return (
    <Column padding="sm" grow gap="sm" className={styles.popover}>
      <Row noWrap>
        <ImageGridPopover items={items} {...rest} />
      </Row>
      <Row>
        <label className={styles.label}>
          <FormattedMessage id="reaction-popover.action" defaultMessage="Actions" />
        </label>
      </Row>
      <Row nowrap>
        <HandRaisedButton active={presence.handRaised} onClick={onToggleHandRaised} />
      </Row>
    </Column>
  );
}

ReactionPopoverContent.propTypes = {
  items: PropTypes.array.isRequired,
  presence: PropTypes.object,
  onToggleHandRaised: PropTypes.func
};

function TooltipPopoverContent({ onToggleHandRaised }) {
  return (
    <Row nowrap className={styles.popover}>
      <Column padding="xs" grow gap="xs">
        <FormattedMessage id="reaction-popover.hand-raised-warning" defaultMessage="Your hand is raised" />
      </Column>
      <Column padding="xs" grow gap="xs">
        <Button sm thin preset={"primary"} onClick={onToggleHandRaised}>
          <FormattedMessage id="reaction-popover.lower-hand" defaultMessage="Lower Hand" />
        </Button>
      </Column>
    </Row>
  );
}

TooltipPopoverContent.propTypes = {
  onToggleHandRaised: PropTypes.func
};

export function ReactionPopoverButton({ items, presence, onToggleHandRaised }) {
  const [isReactionsVisible, setIsReactionsVisible] = useState(false);
  const [isTooltipVisible, setIsTooltipVisible] = useState(false);
  const intl = useIntl();
  const title = intl.formatMessage(reactionPopoverTitle);
  const popoverApiRef = useRef();

  const onTooltipHandLowered = useCallback(
    () => {
      setIsTooltipVisible(false);
      onToggleHandRaised();
    },
    [onToggleHandRaised]
  );

  return (
    <Popover
      title={title}
      content={props => {
        return isTooltipVisible ? (
          <TooltipPopoverContent onToggleHandRaised={onTooltipHandLowered} />
        ) : (
          <ReactionPopoverContent
            items={items}
            presence={presence}
            onToggleHandRaised={onToggleHandRaised}
            {...props}
          />
        );
      }}
      placement="top"
      offsetDistance={28}
      popoverApiRef={popoverApiRef}
      showHeader={!isTooltipVisible}
      isVisible={isReactionsVisible || isTooltipVisible}
      onChangeVisible={visible => {
        if (!visible) {
          setIsReactionsVisible(false);
          setIsTooltipVisible(presence.handRaised);
        }
      }}
      disableFullscreen={isTooltipVisible}
      popoverClass={styles.popover}
    >
      {({ togglePopover, popoverVisible, triggerRef }) => (
        <ToolbarButton
          ref={triggerRef}
          icon={
            presence.handRaised ? (
              <HandRaisedIcon width="32px" height="32px" style={{ marginLeft: "5px" }} />
            ) : (
              <ReactionIcon />
            )
          }
          selected={popoverVisible}
          onClick={() => {
            if (isReactionsVisible) {
              if (presence.handRaised) {
                setIsTooltipVisible(!isTooltipVisible);
                setIsReactionsVisible(!isReactionsVisible);
              } else {
                setIsTooltipVisible(false);
                setIsReactionsVisible(false);
                togglePopover();
              }
            } else {
              if (presence.handRaised) {
                setIsTooltipVisible(!isTooltipVisible);
                setIsReactionsVisible(!isReactionsVisible);
              } else {
                setIsReactionsVisible(true);
                setIsTooltipVisible(false);
                togglePopover();
              }
            }
          }}
          label={title}
          preset="accent2"
        />
      )}
    </Popover>
  );
}

ReactionPopoverButton.propTypes = {
  items: PropTypes.array.isRequired,
  presence: PropTypes.object,
  onToggleHandRaised: PropTypes.func
};
